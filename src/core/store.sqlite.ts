import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  Clarifications,
  EventRow,
  FindingRow,
  RunRow,
  RunStatus,
  StageName,
  StageRow,
  StateStore,
  TokenUsage,
} from "./types.js";

// Single writer; orchestrator is the only process calling mutating methods.
// WAL mode so the (future) web UI can read concurrently without blocking.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  kind TEXT,
  created_at INTEGER NOT NULL,
  requirement_path TEXT NOT NULL,
  spec_path TEXT,
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
  detail_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_run_iter ON findings (run_id, iteration);

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
    this.migrateTokenColumns();
  }

  // Idempotent backfill for databases created before token columns existed.
  // `ADD COLUMN ... DEFAULT 0` on an existing table is non-destructive; the
  // duplicate-column error is the signal that the migration already ran.
  private migrateTokenColumns(): void {
    const tokenCols: Array<[table: string, column: string]> = [
      ["runs", "total_input_tokens"],
      ["runs", "total_cache_creation_tokens"],
      ["runs", "total_cache_read_tokens"],
      ["runs", "total_output_tokens"],
      ["stages", "input_tokens"],
      ["stages", "cache_creation_tokens"],
      ["stages", "cache_read_tokens"],
      ["stages", "output_tokens"],
    ];
    for (const [table, column] of tokenCols) {
      try {
        this.db
          .prepare(
            `ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
          )
          .run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column")) throw err;
      }
    }
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, status, kind, created_at, requirement_path, spec_path, total_cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        row.id,
        row.status,
        row.kind,
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
    patch: Partial<Pick<RunRow, "status" | "kind" | "spec_path" | "total_cost_usd">>,
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

  insertFinding(row: Omit<FindingRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO findings (run_id, iteration, critic, severity, title, detail_path)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.run_id, row.iteration, row.critic, row.severity, row.title, row.detail_path);
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
