import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  Clarifications,
  CriticName,
  EventRow,
  FindingRow,
  RunMode,
  RunRow,
  RunStatus,
  Severity,
  StageName,
  StageRow,
  StateStore,
  TokenUsage,
} from "./types.js";
import { findingFingerprint } from "./types.js";

// Single writer; orchestrator is the only process calling mutating methods.
// WAL mode so the (future) web UI can read concurrently without blocking.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
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
    // Post-migration indexes: the fingerprint column may have just
    // been added; creating the index here (not in SCHEMA) avoids a
    // "no such column" error on pre-migration databases.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS findings_fp ON findings (fingerprint);`,
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
      ["stages", "input_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["stages", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["stages", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["stages", "output_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["findings", "fingerprint", "TEXT NOT NULL DEFAULT ''"],
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, status, kind, mode, created_at, requirement_path, spec_path, total_cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        row.id,
        row.status,
        row.kind,
        row.mode ?? "new",
        row.created_at,
        row.requirement_path,
        row.spec_path ?? null,
      );
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
      Pick<RunRow, "status" | "kind" | "spec_path" | "test_command" | "total_cost_usd">
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

  listRuns(opts: { status?: RunStatus; limit?: number } = {}): RunRow[] {
    const limit = opts.limit ?? 50;
    if (opts.status) {
      return this.db
        .prepare(`SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .all(opts.status, limit) as RunRow[];
    }
    return this.db
      .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as RunRow[];
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

  appendEvent(runId: string, stage: StageName, kind: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO events (run_id, stage, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, stage, Date.now(), kind, JSON.stringify(payload ?? null));
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
}
