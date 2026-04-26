import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  AuthSessionRow,
  Clarifications,
  CriticName,
  DisplayStageRow,
  EventRow,
  FindingRow,
  ProjectCostByMonth,
  ProjectReportAggregates,
  ProjectRow,
  ProjectStageRollup,
  ProjectWebhookRow,
  RunMode,
  RunRow,
  RunStatus,
  Severity,
  StageIterationRow,
  StageName,
  StageRow,
  StateStore,
  TokenUsage,
} from "./types.js";
import { findingFingerprint, STAGE_ORDER } from "./types.js";
import { publishRunEvent } from "./event-bus.js";

// Single writer; orchestrator is the only process calling mutating methods.
// WAL mode so the (future) web UI can read concurrently without blocking.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  monthly_budget_usd REAL,
  default_concurrency INTEGER
);
CREATE INDEX IF NOT EXISTS projects_name ON projects (name);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  status TEXT NOT NULL,
  kind TEXT,
  mode TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL,
  requirement_path TEXT NOT NULL,
  spec_path TEXT,
  -- The resolved test command for this run. In new mode, spec2tests
  -- bootstraps a test runner and writes the command here. In edit
  -- mode, this mirrors profile.commands.test (or overrides it). The
  -- tests critic prefers this over the project profile.
  test_command TEXT,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stages (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  artifact_path TEXT,
  error TEXT,
  PRIMARY KEY (run_id, name)
);

CREATE TABLE IF NOT EXISTS stage_iterations (
  run_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  artifact_path TEXT,
  error TEXT,
  PRIMARY KEY (run_id, stage_name, iteration)
);
CREATE INDEX IF NOT EXISTS stage_iter_run ON stage_iterations (run_id, started_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, id);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  critic TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS findings_run_iter ON findings (run_id, iteration);

CREATE TABLE IF NOT EXISTS suppressed_findings (
  fingerprint TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS clarifications (
  run_id TEXT PRIMARY KEY,
  questions_json TEXT NOT NULL,
  answers_json TEXT,
  kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  session_id TEXT NOT NULL,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, stage)
);

-- Phase 3: cookie-backed UI sessions. Distinct from sessions (which
-- holds per-run-stage claude session ids). Timestamps are unix-ms.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions (expires_at);

-- Phase 3: per-project list of stages that pause a run for human
-- approval before they start. A row means "pause runs in this project
-- after the named stage completes; require explicit approval for the
-- next stage to begin."
CREATE TABLE IF NOT EXISTS project_approval_gates (
  project_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  PRIMARY KEY (project_id, stage_name),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Phase 3: outbound webhook subscriptions, scoped per project. The
-- notify worker fans out events to enabled rows whose event_filter
-- contains the event name.
CREATE TABLE IF NOT EXISTS project_webhooks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  url TEXT NOT NULL,
  event_filter TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_webhooks_project ON project_webhooks (project_id);
`;

function toTokenDelta(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

export class SqliteStateStore implements StateStore {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
  }

  init(): void {
    this.db.exec(SCHEMA);
    this.migrateColumns();
    this.backfillFingerprints();
    // Post-migration indexes: the fingerprint and project_id columns
    // may have just been added; creating the index here (not in SCHEMA)
    // avoids a "no such column" error on pre-migration databases.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS findings_fp ON findings (fingerprint);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS runs_project ON runs (project_id, created_at);`,
    );
  }

  // Idempotent ADD COLUMN backfills for databases that predate later
  // columns. `ADD COLUMN ... DEFAULT <x>` is non-destructive; the
  // duplicate-column error signals the migration already ran.
  private migrateColumns(): void {
    const cols: Array<[table: string, column: string, spec: string]> = [
      ["runs", "total_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["runs", "total_cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["runs", "total_cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["runs", "total_output_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["runs", "mode", "TEXT NOT NULL DEFAULT 'new'"],
      ["runs", "test_command", "TEXT"],
      // project_id is added by ALTER on legacy DBs; new DBs already have
      // it from SCHEMA. The FK reference is only enforced for rows that
      // set the column; null is allowed for legacy rows pre-migration.
      ["runs", "project_id", "TEXT REFERENCES projects(id)"],
      ["stages", "input_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["stages", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["stages", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["stages", "output_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["findings", "fingerprint", "TEXT NOT NULL DEFAULT ''"],
      // Phase 3: gate the next-stage and persist a failure reason so a
      // rejected / budget-paused run is distinguishable from a generic
      // error in the audit trail. Both are nullable; existing rows
      // backfill to NULL which is the right default.
      ["runs", "awaiting_approval_at_stage", "TEXT"],
      ["runs", "failure_reason", "TEXT"],
      // Phase 3: who caused this event. Backfilled to 'mill' for
      // pre-Phase-3 rows by the migration below; the column itself
      // defaults to 'mill' so any direct INSERT that omits it still
      // gets a sane value.
      ["events", "actor", "TEXT NOT NULL DEFAULT 'mill'"],
    ];
    for (const [table, column, spec] of cols) {
      try {
        this.db
          .prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`)
          .run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column")) throw err;
      }
    }
  }

  // Populate fingerprint for any finding rows that were written before
  // the column existed (default was '' after the migration). Uses the
  // same canonical formula as findingFingerprint. Cheap: one UPDATE
  // gated on empty fingerprints.
  private backfillFingerprints(): void {
    const rows = this.db
      .prepare(
        `SELECT id, critic, severity, title FROM findings WHERE fingerprint = ''`,
      )
      .all() as { id: number; critic: string; severity: string; title: string }[];
    if (rows.length === 0) return;
    const update = this.db.prepare(
      `UPDATE findings SET fingerprint = ? WHERE id = ?`,
    );
    const txn = this.db.transaction((items: typeof rows) => {
      for (const r of items) {
        const fp = findingFingerprint({
          critic: r.critic as CriticName,
          severity: r.severity as Severity,
          title: r.title,
        });
        update.run(fp, r.id);
      }
    });
    txn(rows);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createRun(row: {
    id: string;
    status: RunStatus;
    kind: RunRow["kind"];
    created_at: number;
    requirement_path: string;
    spec_path?: string | null;
    mode?: RunMode;
    project_id?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, status, kind, mode, created_at, requirement_path, spec_path, total_cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        row.id,
        row.project_id ?? null,
        row.status,
        row.kind,
        row.mode ?? "new",
        row.created_at,
        row.requirement_path,
        row.spec_path ?? null,
      );
  }

  setRunProjectId(id: string, projectId: string): void {
    this.db
      .prepare(`UPDATE runs SET project_id = ? WHERE id = ?`)
      .run(projectId, id);
  }

  getRun(id: string): RunRow | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
      | RunRow
      | undefined;
    return r ?? null;
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        RunRow,
        | "status"
        | "kind"
        | "spec_path"
        | "test_command"
        | "total_cost_usd"
        | "awaiting_approval_at_stage"
        | "failure_reason"
      >
    >,
  ): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map((k) => patch[k] ?? null);
    this.db.prepare(`UPDATE runs SET ${set} WHERE id = ?`).run(...vals, id);
  }

  addRunCost(id: string, delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.db
      .prepare(`UPDATE runs SET total_cost_usd = total_cost_usd + ? WHERE id = ?`)
      .run(delta, id);
  }

  addRunUsage(id: string, usage: TokenUsage): void {
    const input = toTokenDelta(usage.input);
    const cc = toTokenDelta(usage.cache_creation);
    const cr = toTokenDelta(usage.cache_read);
    const out = toTokenDelta(usage.output);
    if (input === 0 && cc === 0 && cr === 0 && out === 0) return;
    this.db
      .prepare(
        `UPDATE runs SET
           total_input_tokens = total_input_tokens + ?,
           total_cache_creation_tokens = total_cache_creation_tokens + ?,
           total_cache_read_tokens = total_cache_read_tokens + ?,
           total_output_tokens = total_output_tokens + ?
         WHERE id = ?`,
      )
      .run(input, cc, cr, out, id);
  }

  listRuns(
    opts: { status?: RunStatus; limit?: number; projectId?: string } = {},
  ): RunRow[] {
    const limit = opts.limit ?? 50;
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.projectId) {
      where.push("project_id = ?");
      args.push(opts.projectId);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM runs ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...args, limit) as RunRow[];
  }

  // ---- project report aggregates ----
  //
  // The three methods below back the /api/v1/projects/:id/report endpoint.
  // Each is a single SQL pass; volumes are bounded by a project's run
  // history (hundreds at most for a busy project), so we don't need
  // pagination or pre-aggregated tables.

  getProjectReportAggregates(projectId: string): ProjectReportAggregates {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_runs,
           COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
           COALESCE(SUM(total_input_tokens), 0) as total_input_tokens,
           COALESCE(SUM(total_output_tokens), 0) as total_output_tokens,
           COALESCE(SUM(total_cache_read_tokens), 0) as total_cache_read_tokens,
           COALESCE(SUM(total_cache_creation_tokens), 0) as total_cache_creation_tokens,
           MIN(created_at) as first_run_at,
           MAX(created_at) as last_run_at
         FROM runs
         WHERE project_id = ?`,
      )
      .get(projectId) as {
      total_runs: number;
      total_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_read_tokens: number;
      total_cache_creation_tokens: number;
      first_run_at: number | null;
      last_run_at: number | null;
    };

    const statusRows = this.db
      .prepare(
        `SELECT status, COUNT(*) as n FROM runs WHERE project_id = ? GROUP BY status`,
      )
      .all(projectId) as { status: string; n: number }[];
    const by_status: Record<RunStatus, number> = {
      queued: 0,
      awaiting_clarification: 0,
      running: 0,
      completed: 0,
      failed: 0,
      killed: 0,
      paused_budget: 0,
      awaiting_approval: 0,
    };
    for (const r of statusRows) {
      if (r.status in by_status) {
        by_status[r.status as RunStatus] = r.n;
      }
    }

    const modeRows = this.db
      .prepare(
        `SELECT mode, COUNT(*) as n FROM runs WHERE project_id = ? GROUP BY mode`,
      )
      .all(projectId) as { mode: string; n: number }[];
    const by_mode: Record<RunMode, number> = { new: 0, edit: 0 };
    for (const r of modeRows) {
      if (r.mode === "new" || r.mode === "edit") {
        by_mode[r.mode] = r.n;
      }
    }

    // Per-run duration: max(stages.finished_at) - run.created_at. Only
    // counted when the run has at least one finished stage.
    const durRow = this.db
      .prepare(
        `SELECT AVG(dur) as avg_dur FROM (
           SELECT MAX(s.finished_at) - r.created_at AS dur
           FROM runs r
           JOIN stages s ON s.run_id = r.id
           WHERE r.project_id = ? AND s.finished_at IS NOT NULL
           GROUP BY r.id
         )`,
      )
      .get(projectId) as { avg_dur: number | null };

    const denom =
      by_status.completed + by_status.failed + by_status.killed;
    const success_rate = denom > 0 ? by_status.completed / denom : null;
    const avg_cost_usd =
      totals.total_runs > 0 ? totals.total_cost_usd / totals.total_runs : 0;

    return {
      total_runs: totals.total_runs,
      by_status,
      by_mode,
      total_cost_usd: totals.total_cost_usd,
      total_input_tokens: totals.total_input_tokens,
      total_output_tokens: totals.total_output_tokens,
      total_cache_read_tokens: totals.total_cache_read_tokens,
      total_cache_creation_tokens: totals.total_cache_creation_tokens,
      avg_cost_usd,
      first_run_at: totals.first_run_at,
      last_run_at: totals.last_run_at,
      avg_duration_ms: durRow.avg_dur,
      success_rate,
    };
  }

  getProjectCostByMonth(
    projectId: string,
    months: number,
  ): ProjectCostByMonth[] {
    const span = Math.max(1, Math.floor(months));
    // SQLite has no native UTC month bucket; group by strftime('%Y-%m')
    // on a unix-ms timestamp (divide by 1000, treat as seconds).
    const rows = this.db
      .prepare(
        `SELECT
           strftime('%Y-%m', created_at / 1000, 'unixepoch') as month,
           COALESCE(SUM(total_cost_usd), 0) as cost_usd,
           COUNT(*) as run_count
         FROM runs
         WHERE project_id = ?
         GROUP BY month`,
      )
      .all(projectId) as { month: string; cost_usd: number; run_count: number }[];
    const byMonth = new Map<string, { cost_usd: number; run_count: number }>();
    for (const r of rows) {
      byMonth.set(r.month, { cost_usd: r.cost_usd, run_count: r.run_count });
    }
    // Build a contiguous span of `months` calendar months ending in
    // the current UTC month so the UI gets a stable timeline.
    const out: ProjectCostByMonth[] = [];
    const now = new Date();
    let y = now.getUTCFullYear();
    let m = now.getUTCMonth(); // 0-11
    for (let i = 0; i < span; i++) {
      const key = `${y.toString().padStart(4, "0")}-${(m + 1)
        .toString()
        .padStart(2, "0")}`;
      const hit = byMonth.get(key);
      out.unshift({
        month: key,
        cost_usd: hit?.cost_usd ?? 0,
        run_count: hit?.run_count ?? 0,
      });
      m -= 1;
      if (m < 0) {
        m = 11;
        y -= 1;
      }
    }
    return out;
  }

  getProjectStageRollups(projectId: string): ProjectStageRollup[] {
    const rows = this.db
      .prepare(
        `SELECT
           s.name as name,
           COALESCE(SUM(s.cost_usd), 0) as total_cost_usd,
           COUNT(*) as total_runs,
           SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) as failed,
           AVG(CASE
                 WHEN s.status = 'completed' AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL
                 THEN s.finished_at - s.started_at
                 ELSE NULL
               END) as avg_duration_ms
         FROM stages s
         JOIN runs r ON r.id = s.run_id
         WHERE r.project_id = ?
         GROUP BY s.name`,
      )
      .all(projectId) as {
      name: string;
      total_cost_usd: number;
      total_runs: number;
      completed: number;
      failed: number;
      avg_duration_ms: number | null;
    }[];
    const byName = new Map<string, (typeof rows)[number]>();
    for (const r of rows) byName.set(r.name, r);
    return STAGE_ORDER.map((name) => {
      const r = byName.get(name);
      return {
        name,
        total_cost_usd: r?.total_cost_usd ?? 0,
        total_runs: r?.total_runs ?? 0,
        completed: r?.completed ?? 0,
        failed: r?.failed ?? 0,
        avg_duration_ms: r?.avg_duration_ms ?? null,
      };
    });
  }

  // ---- projects ----

  addProject(row: {
    id: string;
    name: string;
    root_path: string;
    added_at?: number;
    monthly_budget_usd?: number | null;
    default_concurrency?: number | null;
  }): ProjectRow {
    const addedAt = row.added_at ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, added_at, monthly_budget_usd, default_concurrency)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.root_path,
        addedAt,
        row.monthly_budget_usd ?? null,
        row.default_concurrency ?? null,
      );
    const got = this.getProject(row.id);
    if (!got) {
      throw new Error(`addProject: insert succeeded but row not found for id=${row.id}`);
    }
    return got;
  }

  getProject(id: string): ProjectRow | null {
    const r = this.db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(id) as ProjectRow | undefined;
    return r ?? null;
  }

  getProjectByPath(rootPath: string): ProjectRow | null {
    const r = this.db
      .prepare(`SELECT * FROM projects WHERE root_path = ?`)
      .get(rootPath) as ProjectRow | undefined;
    return r ?? null;
  }

  getProjectByName(name: string): ProjectRow | null {
    // Names are not unique by schema, but the CLI's `--project <name>`
    // resolves the most-recently-added active project for friendliness.
    const r = this.db
      .prepare(
        `SELECT * FROM projects WHERE name = ? AND removed_at IS NULL ORDER BY added_at DESC LIMIT 1`,
      )
      .get(name) as ProjectRow | undefined;
    return r ?? null;
  }

  listProjects(opts: { includeRemoved?: boolean } = {}): ProjectRow[] {
    const sql = opts.includeRemoved
      ? `SELECT * FROM projects ORDER BY added_at DESC`
      : `SELECT * FROM projects WHERE removed_at IS NULL ORDER BY added_at DESC`;
    return this.db.prepare(sql).all() as ProjectRow[];
  }

  removeProject(id: string): void {
    this.db
      .prepare(`UPDATE projects SET removed_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  updateProjectBudget(id: string, monthlyBudgetUsd: number | null): void {
    this.db
      .prepare(`UPDATE projects SET monthly_budget_usd = ? WHERE id = ?`)
      .run(monthlyBudgetUsd, id);
  }

  updateProjectConcurrency(id: string, defaultConcurrency: number | null): void {
    this.db
      .prepare(`UPDATE projects SET default_concurrency = ? WHERE id = ?`)
      .run(defaultConcurrency, id);
  }

  startStage(runId: string, name: StageName): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO stages (run_id, name, status, started_at, cost_usd)
         VALUES (?, ?, 'running', ?, 0)
         ON CONFLICT(run_id, name) DO UPDATE SET
           status = 'running',
           started_at = excluded.started_at,
           finished_at = NULL,
           error = NULL`,
      )
      .run(runId, name, now);
  }

  finishStage(
    runId: string,
    name: StageName,
    patch: Partial<Omit<StageRow, "run_id" | "name">>,
  ): void {
    const existing = this.getStage(runId, name);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO stages (run_id, name, status, cost_usd) VALUES (?, ?, 'pending', 0)`,
        )
        .run(runId, name);
    }
    const fields: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = ?`);
      vals.push(v ?? null);
    }
    if (!fields.some((f) => f.startsWith("finished_at"))) {
      fields.push("finished_at = ?");
      vals.push(Date.now());
    }
    this.db
      .prepare(`UPDATE stages SET ${fields.join(", ")} WHERE run_id = ? AND name = ?`)
      .run(...vals, runId, name);
  }

  addStageCost(runId: string, name: StageName, delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.db
      .prepare(
        `UPDATE stages SET cost_usd = cost_usd + ? WHERE run_id = ? AND name = ?`,
      )
      .run(delta, runId, name);
  }

  addStageUsage(runId: string, name: StageName, usage: TokenUsage): void {
    const input = toTokenDelta(usage.input);
    const cc = toTokenDelta(usage.cache_creation);
    const cr = toTokenDelta(usage.cache_read);
    const out = toTokenDelta(usage.output);
    if (input === 0 && cc === 0 && cr === 0 && out === 0) return;
    this.db
      .prepare(
        `UPDATE stages SET
           input_tokens = input_tokens + ?,
           cache_creation_tokens = cache_creation_tokens + ?,
           cache_read_tokens = cache_read_tokens + ?,
           output_tokens = output_tokens + ?
         WHERE run_id = ? AND name = ?`,
      )
      .run(input, cc, cr, out, runId, name);
  }

  setStageSession(runId: string, name: StageName, sessionId: string): void {
    if (!sessionId) return;
    this.db
      .prepare(
        `UPDATE stages SET session_id = ? WHERE run_id = ? AND name = ?`,
      )
      .run(sessionId, runId, name);
  }

  getStage(runId: string, name: StageName): StageRow | null {
    const r = this.db
      .prepare(`SELECT * FROM stages WHERE run_id = ? AND name = ?`)
      .get(runId, name) as StageRow | undefined;
    return r ?? null;
  }

  listStages(runId: string): StageRow[] {
    return this.db
      .prepare(`SELECT * FROM stages WHERE run_id = ? ORDER BY started_at`)
      .all(runId) as StageRow[];
  }

  startStageIteration(runId: string, name: StageName, iteration: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO stage_iterations (run_id, stage_name, iteration, status, started_at, cost_usd)
         VALUES (?, ?, ?, 'running', ?, 0)
         ON CONFLICT(run_id, stage_name, iteration) DO UPDATE SET
           status = 'running',
           started_at = excluded.started_at,
           finished_at = NULL,
           error = NULL`,
      )
      .run(runId, name, iteration, now);
  }

  finishStageIteration(
    runId: string,
    name: StageName,
    iteration: number,
    patch: Partial<Omit<StageIterationRow, "run_id" | "stage_name" | "iteration">>,
  ): void {
    const existing = this.getStageIteration(runId, name, iteration);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO stage_iterations (run_id, stage_name, iteration, status, cost_usd) VALUES (?, ?, ?, 'pending', 0)`,
        )
        .run(runId, name, iteration);
    }
    const fields: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = ?`);
      vals.push(v ?? null);
    }
    if (!fields.some((f) => f.startsWith("finished_at"))) {
      fields.push("finished_at = ?");
      vals.push(Date.now());
    }
    this.db
      .prepare(
        `UPDATE stage_iterations SET ${fields.join(", ")} WHERE run_id = ? AND stage_name = ? AND iteration = ?`,
      )
      .run(...vals, runId, name, iteration);
  }

  addStageIterationCost(
    runId: string,
    name: StageName,
    iteration: number,
    delta: number,
  ): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.ensureStageIteration(runId, name, iteration);
    this.db
      .prepare(
        `UPDATE stage_iterations SET cost_usd = cost_usd + ?
         WHERE run_id = ? AND stage_name = ? AND iteration = ?`,
      )
      .run(delta, runId, name, iteration);
  }

  addStageIterationUsage(
    runId: string,
    name: StageName,
    iteration: number,
    usage: TokenUsage,
  ): void {
    const input = toTokenDelta(usage.input);
    const cc = toTokenDelta(usage.cache_creation);
    const cr = toTokenDelta(usage.cache_read);
    const out = toTokenDelta(usage.output);
    if (input === 0 && cc === 0 && cr === 0 && out === 0) return;
    this.ensureStageIteration(runId, name, iteration);
    this.db
      .prepare(
        `UPDATE stage_iterations SET
           input_tokens = input_tokens + ?,
           cache_creation_tokens = cache_creation_tokens + ?,
           cache_read_tokens = cache_read_tokens + ?,
           output_tokens = output_tokens + ?
         WHERE run_id = ? AND stage_name = ? AND iteration = ?`,
      )
      .run(input, cc, cr, out, runId, name, iteration);
  }

  setStageIterationSession(
    runId: string,
    name: StageName,
    iteration: number,
    sessionId: string,
  ): void {
    if (!sessionId) return;
    this.ensureStageIteration(runId, name, iteration);
    this.db
      .prepare(
        `UPDATE stage_iterations SET session_id = ?
         WHERE run_id = ? AND stage_name = ? AND iteration = ?`,
      )
      .run(sessionId, runId, name, iteration);
  }

  getStageIteration(
    runId: string,
    name: StageName,
    iteration: number,
  ): StageIterationRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM stage_iterations WHERE run_id = ? AND stage_name = ? AND iteration = ?`,
      )
      .get(runId, name, iteration) as StageIterationRow | undefined;
    return r ?? null;
  }

  listStageIterations(runId: string, name?: StageName): StageIterationRow[] {
    if (name) {
      return this.db
        .prepare(
          `SELECT * FROM stage_iterations WHERE run_id = ? AND stage_name = ? ORDER BY iteration`,
        )
        .all(runId, name) as StageIterationRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM stage_iterations WHERE run_id = ? ORDER BY stage_name, iteration`,
      )
      .all(runId) as StageIterationRow[];
  }

  // INSERT-OR-IGNORE the row before delta updates so the very first
  // cost/usage delta from runClaude doesn't silently no-op against an
  // empty table when the stage driver's `startStageIteration` hasn't
  // landed yet (it does today, but defense in depth — same shape as
  // finishStage's existing-row INSERT).
  private ensureStageIteration(
    runId: string,
    name: StageName,
    iteration: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO stage_iterations
           (run_id, stage_name, iteration, status, cost_usd)
         VALUES (?, ?, ?, 'running', 0)`,
      )
      .run(runId, name, iteration);
  }

  listDisplayStages(runId: string): DisplayStageRow[] {
    const stages = this.listStages(runId);
    const iters = this.listStageIterations(runId);
    const itersByStage = new Map<StageName, StageIterationRow[]>();
    for (const it of iters) {
      const arr = itersByStage.get(it.stage_name as StageName) ?? [];
      arr.push(it);
      itersByStage.set(it.stage_name as StageName, arr);
    }
    const out: DisplayStageRow[] = [];
    for (const s of stages) {
      const stageIters = itersByStage.get(s.name) ?? [];
      // Always expand to per-iteration rows when the sibling table has
      // data — even a single iteration. This keeps the live ticker
      // honest about iteration boundaries (each implement / review row
      // gets its own ▸/✓ pair); the suffix `#1` is suppressed when
      // there's only one iteration so the table stays tidy.
      if (stageIters.length === 0) {
        out.push({
          run_id: s.run_id,
          name: s.name,
          displayName: s.name,
          iteration: null,
          status: s.status,
          started_at: s.started_at,
          finished_at: s.finished_at,
          cost_usd: s.cost_usd,
          input_tokens: s.input_tokens,
          cache_creation_tokens: s.cache_creation_tokens,
          cache_read_tokens: s.cache_read_tokens,
          output_tokens: s.output_tokens,
          session_id: s.session_id,
          artifact_path: s.artifact_path,
          error: s.error,
        });
        continue;
      }
      const showSuffix = stageIters.length > 1;
      for (const it of stageIters) {
        out.push({
          run_id: it.run_id,
          name: s.name,
          displayName: showSuffix ? `${s.name} #${it.iteration}` : s.name,
          iteration: it.iteration,
          status: it.status,
          started_at: it.started_at,
          finished_at: it.finished_at,
          cost_usd: it.cost_usd,
          input_tokens: it.input_tokens,
          cache_creation_tokens: it.cache_creation_tokens,
          cache_read_tokens: it.cache_read_tokens,
          output_tokens: it.output_tokens,
          session_id: it.session_id,
          artifact_path: it.artifact_path,
          error: it.error,
        });
      }
    }
    out.sort((a, b) => {
      const sa = a.started_at ?? Infinity;
      const sb = b.started_at ?? Infinity;
      if (sa !== sb) return sa - sb;
      // Same started_at (rare; possible for never-started rows) — keep
      // iteration order within a stage and stage order otherwise.
      if (a.name !== b.name) return 0;
      return (a.iteration ?? 0) - (b.iteration ?? 0);
    });
    return out;
  }

  appendEvent(
    runId: string,
    stage: StageName,
    kind: string,
    payload: unknown,
    actor: string = "mill",
  ): void {
    const ts = Date.now();
    const payloadJson = JSON.stringify(payload ?? null);
    const info = this.db
      .prepare(
        `INSERT INTO events (run_id, stage, ts, kind, payload_json, actor) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, stage, ts, kind, payloadJson, actor);
    // Fanout to in-process subscribers (SSE) only after the INSERT
    // succeeds — a thrown prepare/run keeps the bus untouched. The id
    // is the autoincrement assigned by SQLite, surfaced as
    // lastInsertRowid (number for our schema). Build the row inline
    // rather than re-reading; we have every field already.
    publishRunEvent({
      id: Number(info.lastInsertRowid),
      run_id: runId,
      stage,
      ts,
      kind,
      actor,
      payload_json: payloadJson,
    });
  }

  tailEvents(runId: string, afterId = 0, limit = 200): EventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?`,
      )
      .all(runId, afterId, limit) as EventRow[];
  }

  insertFinding(row: Omit<FindingRow, "id" | "fingerprint">): void {
    const fp = findingFingerprint({
      critic: row.critic,
      severity: row.severity,
      title: row.title,
    });
    this.db
      .prepare(
        `INSERT INTO findings (run_id, iteration, critic, severity, title, detail_path, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.run_id,
        row.iteration,
        row.critic,
        row.severity,
        row.title,
        row.detail_path,
        fp,
      );
  }

  listFindings(runId: string, opts: { iteration?: number } = {}): FindingRow[] {
    if (typeof opts.iteration === "number") {
      return this.db
        .prepare(
          `SELECT * FROM findings WHERE run_id = ? AND iteration = ? ORDER BY id`,
        )
        .all(runId, opts.iteration) as FindingRow[];
    }
    return this.db
      .prepare(`SELECT * FROM findings WHERE run_id = ? ORDER BY id`)
      .all(runId) as FindingRow[];
  }

  listLedgerEntries(
    opts: {
      minRuns?: number;
      includeSuppressed?: boolean;
      limit?: number;
    } = {},
  ): import("./types.js").LedgerEntry[] {
    const limit = opts.limit ?? 200;
    const minRuns = opts.minRuns ?? 1;
    // GROUP BY fingerprint; pull max severity (by ordinal) and latest
    // detail_path via a correlated pick. SQLite doesn't have a native
    // "pick one" aggregate, so we MAX(id) per group and join back.
    const rows = this.db
      .prepare(
        `SELECT
           f.fingerprint as fingerprint,
           f.critic as critic,
           f.severity as severity,
           f.title as title,
           COUNT(DISTINCT f.run_id) as run_count,
           COUNT(f.id) as occurrence_count,
           MIN(r.created_at) as first_seen,
           MAX(r.created_at) as last_seen,
           (SELECT detail_path FROM findings f2
              WHERE f2.fingerprint = f.fingerprint
              ORDER BY f2.id DESC LIMIT 1) as example_path,
           CASE WHEN sf.fingerprint IS NULL THEN 0 ELSE 1 END as suppressed
         FROM findings f
         JOIN runs r ON r.id = f.run_id
         LEFT JOIN suppressed_findings sf ON sf.fingerprint = f.fingerprint
         WHERE f.fingerprint <> ''
         GROUP BY f.fingerprint
         HAVING run_count >= ?
         ORDER BY run_count DESC, last_seen DESC
         LIMIT ?`,
      )
      .all(minRuns, limit) as Array<{
      fingerprint: string;
      critic: string;
      severity: string;
      title: string;
      run_count: number;
      occurrence_count: number;
      first_seen: number;
      last_seen: number;
      example_path: string | null;
      suppressed: number;
    }>;
    const filtered = opts.includeSuppressed
      ? rows
      : rows.filter((r) => r.suppressed === 0);
    return filtered.map((r) => ({
      fingerprint: r.fingerprint,
      critic: r.critic as CriticName,
      severity: r.severity as Severity,
      title: r.title,
      runCount: r.run_count,
      occurrenceCount: r.occurrence_count,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      suppressed: Boolean(r.suppressed),
      exampleDetailPath: r.example_path,
    }));
  }

  suppressFingerprint(fingerprint: string, note?: string): void {
    this.db
      .prepare(
        `INSERT INTO suppressed_findings (fingerprint, added_at, note)
         VALUES (?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           added_at = excluded.added_at,
           note = excluded.note`,
      )
      .run(fingerprint, Date.now(), note ?? null);
  }

  unsuppressFingerprint(fingerprint: string): void {
    this.db
      .prepare(`DELETE FROM suppressed_findings WHERE fingerprint = ?`)
      .run(fingerprint);
  }

  listSuppressedFingerprints(): {
    fingerprint: string;
    added_at: number;
    note: string | null;
  }[] {
    return this.db
      .prepare(
        `SELECT fingerprint, added_at, note FROM suppressed_findings ORDER BY added_at DESC`,
      )
      .all() as {
      fingerprint: string;
      added_at: number;
      note: string | null;
    }[];
  }

  saveClarifications(runId: string, c: Clarifications): void {
    this.db
      .prepare(
        `INSERT INTO clarifications (run_id, questions_json, answers_json, kind)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           questions_json = excluded.questions_json,
           answers_json   = excluded.answers_json,
           kind           = excluded.kind`,
      )
      .run(
        runId,
        JSON.stringify(c.questions),
        c.answers ? JSON.stringify(c.answers) : null,
        c.kind,
      );
  }

  getClarifications(runId: string): Clarifications | null {
    const row = this.db
      .prepare(`SELECT * FROM clarifications WHERE run_id = ?`)
      .get(runId) as
      | { questions_json: string; answers_json: string | null; kind: string }
      | undefined;
    if (!row) return null;
    return {
      kind: row.kind as Clarifications["kind"],
      questions: JSON.parse(row.questions_json),
      answers: row.answers_json ? JSON.parse(row.answers_json) : undefined,
    };
  }

  saveSession(
    runId: string,
    slot: string,
    sessionId: string,
    totalCostUsd: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO sessions (run_id, stage, session_id, total_cost_usd, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, stage) DO UPDATE SET
           session_id = excluded.session_id,
           total_cost_usd = excluded.total_cost_usd,
           updated_at = excluded.updated_at`,
      )
      .run(runId, slot, sessionId, totalCostUsd, Date.now());
  }

  getSession(
    runId: string,
    slot: string,
  ): { sessionId: string; totalCostUsd: number } | null {
    const row = this.db
      .prepare(
        `SELECT session_id, total_cost_usd FROM sessions WHERE run_id = ? AND stage = ?`,
      )
      .get(runId, slot) as
      | { session_id: string; total_cost_usd: number }
      | undefined;
    if (!row) return null;
    return { sessionId: row.session_id, totalCostUsd: row.total_cost_usd };
  }

  // ---- Phase 3: auth sessions ----

  createAuthSession(row: {
    id: string;
    actor: string;
    created_at?: number;
    last_seen_at?: number;
    expires_at: number;
  }): AuthSessionRow {
    const now = Date.now();
    const created = row.created_at ?? now;
    const lastSeen = row.last_seen_at ?? created;
    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, actor, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.actor, created, lastSeen, row.expires_at);
    return {
      id: row.id,
      actor: row.actor,
      created_at: created,
      last_seen_at: lastSeen,
      expires_at: row.expires_at,
    };
  }

  findAuthSession(id: string): AuthSessionRow | null {
    const r = this.db
      .prepare(`SELECT * FROM auth_sessions WHERE id = ?`)
      .get(id) as AuthSessionRow | undefined;
    if (!r) return null;
    if (r.expires_at <= Date.now()) return null;
    return r;
  }

  touchAuthSession(id: string, newExpiresAt: number): AuthSessionRow | null {
    const existing = this.findAuthSession(id);
    if (!existing) return null;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`,
      )
      .run(now, newExpiresAt, id);
    return {
      ...existing,
      last_seen_at: now,
      expires_at: newExpiresAt,
    };
  }

  deleteAuthSession(id: string): void {
    this.db.prepare(`DELETE FROM auth_sessions WHERE id = ?`).run(id);
  }

  deleteAllAuthSessions(): void {
    this.db.prepare(`DELETE FROM auth_sessions`).run();
  }

  deleteExpiredAuthSessions(now: number = Date.now()): number {
    const info = this.db
      .prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`)
      .run(now);
    return Number(info.changes);
  }

  // ---- Phase 3: approval gates ----

  setProjectGates(projectId: string, stages: StageName[]): void {
    // Full-replace semantics. Wrapped in a transaction so the table is
    // never observed half-empty by a concurrent reader.
    const del = this.db.prepare(
      `DELETE FROM project_approval_gates WHERE project_id = ?`,
    );
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO project_approval_gates (project_id, stage_name) VALUES (?, ?)`,
    );
    const txn = this.db.transaction((items: StageName[]) => {
      del.run(projectId);
      for (const s of items) ins.run(projectId, s);
    });
    txn(stages);
  }

  clearProjectGates(projectId: string): void {
    this.db
      .prepare(`DELETE FROM project_approval_gates WHERE project_id = ?`)
      .run(projectId);
  }

  listProjectGates(projectId: string): StageName[] {
    const rows = this.db
      .prepare(
        `SELECT stage_name FROM project_approval_gates WHERE project_id = ? ORDER BY stage_name`,
      )
      .all(projectId) as { stage_name: string }[];
    return rows.map((r) => r.stage_name as StageName);
  }

  // ---- Phase 3: webhooks ----

  createWebhook(row: {
    id: string;
    project_id: string;
    url: string;
    event_filter: string;
    secret: string;
    enabled?: boolean;
    created_at?: number;
  }): ProjectWebhookRow {
    const createdAt = row.created_at ?? Date.now();
    const enabled = row.enabled === false ? 0 : 1;
    this.db
      .prepare(
        `INSERT INTO project_webhooks
           (id, project_id, url, event_filter, secret, enabled, consecutive_failures, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        row.id,
        row.project_id,
        row.url,
        row.event_filter,
        row.secret,
        enabled,
        createdAt,
      );
    const got = this.getWebhook(row.id);
    if (!got) {
      throw new Error(
        `createWebhook: insert succeeded but row not found for id=${row.id}`,
      );
    }
    return got;
  }

  listWebhooksByProject(projectId: string): ProjectWebhookRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM project_webhooks WHERE project_id = ? ORDER BY created_at DESC`,
      )
      .all(projectId) as RawWebhookRow[];
    return rows.map(toWebhookRow);
  }

  listWebhooksByEvent(
    projectId: string,
    eventName: string,
  ): ProjectWebhookRow[] {
    // event_filter is a comma-separated list. Filter in JS — the table is
    // tiny per project (handful of rows) so a SUBSTR-based SQL match
    // would be fragile (substring collisions like "run.completed" vs
    // "run.completed_async") for negligible perf gain.
    const all = this.db
      .prepare(
        `SELECT * FROM project_webhooks WHERE project_id = ? AND enabled = 1`,
      )
      .all(projectId) as RawWebhookRow[];
    return all
      .filter((r) => parseEventFilter(r.event_filter).has(eventName))
      .map(toWebhookRow);
  }

  getWebhook(id: string): ProjectWebhookRow | null {
    const r = this.db
      .prepare(`SELECT * FROM project_webhooks WHERE id = ?`)
      .get(id) as RawWebhookRow | undefined;
    return r ? toWebhookRow(r) : null;
  }

  deleteWebhook(id: string): void {
    this.db.prepare(`DELETE FROM project_webhooks WHERE id = ?`).run(id);
  }

  incWebhookFailures(id: string): number {
    this.db
      .prepare(
        `UPDATE project_webhooks SET consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
      )
      .run(id);
    const r = this.db
      .prepare(`SELECT consecutive_failures FROM project_webhooks WHERE id = ?`)
      .get(id) as { consecutive_failures: number } | undefined;
    return r ? r.consecutive_failures : 0;
  }

  resetWebhookFailures(id: string): void {
    this.db
      .prepare(`UPDATE project_webhooks SET consecutive_failures = 0 WHERE id = ?`)
      .run(id);
  }

  disableWebhook(id: string): void {
    this.db
      .prepare(`UPDATE project_webhooks SET enabled = 0 WHERE id = ?`)
      .run(id);
  }

  // Test-only escape hatch: hard-delete the project row so the FK
  // ON DELETE CASCADE on dependent tables fires. Production code uses
  // removeProject (soft delete via removed_at). Lives in the production
  // store rather than reaching into private state from tests.
  hardDeleteProjectForTest(id: string): void {
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }

  // Test-only escape hatch: drop the events.actor column so a subsequent
  // init() exercises the migrateColumns ADD COLUMN path on a "pre-Phase-3"
  // DB. SQLite 3.35+ supports DROP COLUMN.
  simulateLegacyEventsSchemaForTest(): void {
    this.db.prepare(`ALTER TABLE events DROP COLUMN actor`).run();
  }

  // Test-only escape hatch: insert a raw event row without the actor
  // column. Used in tandem with simulateLegacyEventsSchemaForTest to
  // verify that migrateColumns backfills 'mill' onto pre-existing rows.
  insertRawEventForTest(
    runId: string,
    stage: string,
    ts: number,
    kind: string,
    payloadJson: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (run_id, stage, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, stage, ts, kind, payloadJson);
  }
}

interface RawWebhookRow {
  id: string;
  project_id: string;
  url: string;
  event_filter: string;
  secret: string;
  enabled: number;
  consecutive_failures: number;
  created_at: number;
}

function toWebhookRow(r: RawWebhookRow): ProjectWebhookRow {
  return {
    id: r.id,
    project_id: r.project_id,
    url: r.url,
    event_filter: r.event_filter,
    secret: r.secret,
    enabled: r.enabled === 1,
    consecutive_failures: r.consecutive_failures,
    created_at: r.created_at,
  };
}

function parseEventFilter(filter: string): Set<string> {
  return new Set(
    filter
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}
