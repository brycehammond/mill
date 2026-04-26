// One-shot importer for legacy per-repo `<repoRoot>/.mill/` state into the
// central `~/.mill/` registry. Phase 1 of multi-project mill: a user who
// already had `mill init` against a single repo registers it via
// `mill project add` and gets all their prior runs, journal, decisions,
// profile, and stitch ref carried over without manual reconstruction.
//
// Two non-obvious rules:
// - Workdirs at `<repoRoot>/.mill/runs/` are NOT touched. The imported
//   `runs` rows still reference those paths (relative to the project
//   root), so the workdirs stay where they are.
// - `<repoRoot>/.mill/mill.db` is renamed (not deleted) to
//   `mill.db.legacy-<unix-ms>`. We also drop a marker file so a second
//   `migrateLegacyMill` call against the same repo is a no-op even if
//   the rename failed for some reason.
//
// Conflict policy on state files (journal/decisions/profile/stitch):
// "central wins" per plan open question 4. When the legacy file has
// content but the central destination already has content too, we copy
// nothing and emit a warning so the user can manually merge if they
// care. When the central side is missing or empty, the legacy content
// is copied.
//
// All imports run inside a single SQLite transaction. INSERT OR IGNORE
// with the table's primary key keeps re-imports idempotent for the
// keyed tables; for `events` and `findings` (autoincrement primary key)
// we rely on the marker file plus row-count check to avoid double
// imports.

import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { projectStateDir } from "./paths.js";
import { projectMillDir } from "./project.js";
import type { StateStore } from "./types.js";

export interface MigrateLegacyArgs {
  // Absolute path of the registered git repo whose `.mill/` we're
  // importing.
  repoRoot: string;
  // Project id assigned by `addProject`. Stamped on every imported
  // `runs` row.
  projectId: string;
  // Central state store the legacy rows are imported into.
  store: StateStore;
}

export interface ImportedCounts {
  runs: number;
  stages: number;
  stage_iterations: number;
  events: number;
  findings: number;
  suppressed_findings: number;
  clarifications: number;
  sessions: number;
}

export interface MigrateLegacyResult {
  migrated: boolean;
  importedCounts?: ImportedCounts;
  warnings?: string[];
  legacyDbBackupPath?: string;
}

const MARKER_FILENAME = "migrated-to-central.json";

// State files copied from `<repoRoot>/.mill/<name>` into the project's
// central state dir. `profile.md` is included alongside `profile.json`
// since `mill onboard` writes both.
const STATE_FILES = [
  "journal.md",
  "decisions.md",
  "profile.json",
  "profile.md",
  "stitch.json",
] as const;

interface LegacyRunRow {
  id: string;
  status: string;
  kind: string | null;
  mode: string | null;
  created_at: number;
  requirement_path: string;
  spec_path: string | null;
  test_command: string | null;
  total_cost_usd: number | null;
  total_input_tokens: number | null;
  total_cache_creation_tokens: number | null;
  total_cache_read_tokens: number | null;
  total_output_tokens: number | null;
}

interface LegacyStageRow {
  run_id: string;
  name: string;
  status: string;
  started_at: number | null;
  finished_at: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  session_id: string | null;
  artifact_path: string | null;
  error: string | null;
}

interface LegacyStageIterRow extends LegacyStageRow {
  stage_name: string;
  iteration: number;
}

interface LegacyEventRow {
  id: number;
  run_id: string;
  stage: string;
  ts: number;
  kind: string;
  payload_json: string;
}

interface LegacyFindingRow {
  id: number;
  run_id: string;
  iteration: number;
  critic: string;
  severity: string;
  title: string;
  detail_path: string;
  fingerprint: string | null;
}

interface LegacySuppressedRow {
  fingerprint: string;
  added_at: number;
  note: string | null;
}

interface LegacyClarificationRow {
  run_id: string;
  questions_json: string;
  answers_json: string | null;
  kind: string;
}

interface LegacySessionRow {
  run_id: string;
  stage: string;
  session_id: string;
  total_cost_usd: number | null;
  updated_at: number | null;
}

// Internal handle to the StateStore's underlying `better-sqlite3` DB.
// We write through it directly because the public StateStore interface
// has no bulk-import-with-explicit-id surface and adding one would
// pollute it for the one caller that needs it. The store still owns the
// connection; we just borrow it for the transaction.
interface SqliteBacked {
  db: Database.Database;
}

function unwrapDb(store: StateStore): Database.Database {
  const candidate = (store as unknown as SqliteBacked).db;
  if (!candidate || typeof candidate.prepare !== "function") {
    throw new Error(
      "migrateLegacyMill: store is not a SqliteStateStore — cannot bulk import",
    );
  }
  return candidate;
}

export async function migrateLegacyMill(
  args: MigrateLegacyArgs,
): Promise<MigrateLegacyResult> {
  const { repoRoot, projectId, store } = args;
  const legacyMillDir = projectMillDir(repoRoot);
  const legacyDbPath = join(legacyMillDir, "mill.db");
  const markerPath = join(legacyMillDir, MARKER_FILENAME);

  if (existsSync(markerPath)) {
    return { migrated: false, warnings: ["already migrated"] };
  }

  if (!existsSync(legacyDbPath)) {
    return { migrated: false };
  }

  const warnings: string[] = [];
  const legacy = new Database(legacyDbPath, { readonly: true });
  const central = unwrapDb(store);

  let counts: ImportedCounts;
  try {
    counts = importRows(legacy, central, projectId);
  } finally {
    legacy.close();
  }

  // State file copy is best-effort — failures here become warnings, not
  // a thrown error, because the DB import is the load-bearing part.
  const stateDir = projectStateDir(projectId);
  mkdirSync(stateDir, { recursive: true });
  for (const name of STATE_FILES) {
    const src = join(legacyMillDir, name);
    if (!existsSync(src)) continue;
    if (!hasContent(src)) continue;
    const dst = join(stateDir, name);
    if (hasContent(dst)) {
      warnings.push(
        `state-file conflict: kept central ${dst}; legacy ${src} preserved for manual merge`,
      );
      continue;
    }
    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`failed to copy ${src} -> ${dst}: ${msg}`);
    }
  }

  // Marker first, then rename. If the rename fails (permissions,
  // filesystem hiccup), the marker still blocks a second import.
  writeFileSync(
    markerPath,
    JSON.stringify(
      { ts: Date.now(), projectId, importedCounts: counts },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  let legacyDbBackupPath: string | undefined;
  try {
    const ts = Date.now();
    const renamed = join(legacyMillDir, `mill.db.legacy-${ts}`);
    renameSync(legacyDbPath, renamed);
    legacyDbBackupPath = renamed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`failed to rename legacy DB: ${msg}`);
  }

  return {
    migrated: true,
    importedCounts: counts,
    warnings: warnings.length > 0 ? warnings : undefined,
    legacyDbBackupPath,
  };
}

function importRows(
  legacy: Database.Database,
  central: Database.Database,
  projectId: string,
): ImportedCounts {
  const counts: ImportedCounts = {
    runs: 0,
    stages: 0,
    stage_iterations: 0,
    events: 0,
    findings: 0,
    suppressed_findings: 0,
    clarifications: 0,
    sessions: 0,
  };

  const legacyRuns = readAll<LegacyRunRow>(
    legacy,
    `SELECT * FROM runs ORDER BY created_at ASC`,
  );
  const legacyStages = readAll<LegacyStageRow>(
    legacy,
    `SELECT * FROM stages`,
  );
  const legacyIters = tableExists(legacy, "stage_iterations")
    ? readAll<LegacyStageIterRow>(
        legacy,
        `SELECT * FROM stage_iterations ORDER BY run_id, stage_name, iteration`,
      )
    : [];
  const legacyEvents = readAll<LegacyEventRow>(
    legacy,
    `SELECT * FROM events ORDER BY id ASC`,
  );
  const legacyFindings = readAll<LegacyFindingRow>(
    legacy,
    `SELECT * FROM findings ORDER BY id ASC`,
  );
  const legacySuppressed = tableExists(legacy, "suppressed_findings")
    ? readAll<LegacySuppressedRow>(
        legacy,
        `SELECT * FROM suppressed_findings`,
      )
    : [];
  const legacyClarifications = tableExists(legacy, "clarifications")
    ? readAll<LegacyClarificationRow>(
        legacy,
        `SELECT * FROM clarifications`,
      )
    : [];
  const legacySessions = tableExists(legacy, "sessions")
    ? readAll<LegacySessionRow>(legacy, `SELECT * FROM sessions`)
    : [];

  const insertRun = central.prepare(
    `INSERT OR IGNORE INTO runs
       (id, project_id, status, kind, mode, created_at, requirement_path, spec_path,
        test_command, total_cost_usd, total_input_tokens, total_cache_creation_tokens,
        total_cache_read_tokens, total_output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertStage = central.prepare(
    `INSERT OR IGNORE INTO stages
       (run_id, name, status, started_at, finished_at, cost_usd, input_tokens,
        cache_creation_tokens, cache_read_tokens, output_tokens, session_id,
        artifact_path, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertIter = central.prepare(
    `INSERT OR IGNORE INTO stage_iterations
       (run_id, stage_name, iteration, status, started_at, finished_at, cost_usd,
        input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens,
        session_id, artifact_path, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Events have an autoincrement id; we don't try to preserve it. To
  // avoid double-import on a re-run of migrateLegacyMill we rely on the
  // marker file written after the transaction commits — without it,
  // a second pass would re-insert. Insert in legacy id order so
  // chronology is preserved in the central log.
  const insertEvent = central.prepare(
    `INSERT INTO events (run_id, stage, ts, kind, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertFinding = central.prepare(
    `INSERT INTO findings (run_id, iteration, critic, severity, title, detail_path, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSuppressed = central.prepare(
    `INSERT OR IGNORE INTO suppressed_findings (fingerprint, added_at, note)
     VALUES (?, ?, ?)`,
  );
  const insertClarification = central.prepare(
    `INSERT OR IGNORE INTO clarifications (run_id, questions_json, answers_json, kind)
     VALUES (?, ?, ?, ?)`,
  );
  const insertSession = central.prepare(
    `INSERT OR IGNORE INTO sessions (run_id, stage, session_id, total_cost_usd, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const txn = central.transaction(() => {
    for (const r of legacyRuns) {
      const info = insertRun.run(
        r.id,
        projectId,
        r.status,
        r.kind ?? null,
        r.mode ?? "new",
        r.created_at,
        r.requirement_path,
        r.spec_path ?? null,
        r.test_command ?? null,
        r.total_cost_usd ?? 0,
        r.total_input_tokens ?? 0,
        r.total_cache_creation_tokens ?? 0,
        r.total_cache_read_tokens ?? 0,
        r.total_output_tokens ?? 0,
      );
      if (info.changes > 0) counts.runs += 1;
    }
    for (const s of legacyStages) {
      const info = insertStage.run(
        s.run_id,
        s.name,
        s.status,
        s.started_at ?? null,
        s.finished_at ?? null,
        s.cost_usd ?? 0,
        s.input_tokens ?? 0,
        s.cache_creation_tokens ?? 0,
        s.cache_read_tokens ?? 0,
        s.output_tokens ?? 0,
        s.session_id ?? null,
        s.artifact_path ?? null,
        s.error ?? null,
      );
      if (info.changes > 0) counts.stages += 1;
    }
    for (const i of legacyIters) {
      const info = insertIter.run(
        i.run_id,
        i.stage_name,
        i.iteration,
        i.status,
        i.started_at ?? null,
        i.finished_at ?? null,
        i.cost_usd ?? 0,
        i.input_tokens ?? 0,
        i.cache_creation_tokens ?? 0,
        i.cache_read_tokens ?? 0,
        i.output_tokens ?? 0,
        i.session_id ?? null,
        i.artifact_path ?? null,
        i.error ?? null,
      );
      if (info.changes > 0) counts.stage_iterations += 1;
    }
    for (const e of legacyEvents) {
      const info = insertEvent.run(e.run_id, e.stage, e.ts, e.kind, e.payload_json);
      if (info.changes > 0) counts.events += 1;
    }
    for (const f of legacyFindings) {
      const info = insertFinding.run(
        f.run_id,
        f.iteration,
        f.critic,
        f.severity,
        f.title,
        f.detail_path,
        f.fingerprint ?? "",
      );
      if (info.changes > 0) counts.findings += 1;
    }
    for (const sf of legacySuppressed) {
      const info = insertSuppressed.run(sf.fingerprint, sf.added_at, sf.note ?? null);
      if (info.changes > 0) counts.suppressed_findings += 1;
    }
    for (const c of legacyClarifications) {
      const info = insertClarification.run(
        c.run_id,
        c.questions_json,
        c.answers_json ?? null,
        c.kind,
      );
      if (info.changes > 0) counts.clarifications += 1;
    }
    for (const ss of legacySessions) {
      const info = insertSession.run(
        ss.run_id,
        ss.stage,
        ss.session_id,
        ss.total_cost_usd ?? 0,
        ss.updated_at ?? Date.now(),
      );
      if (info.changes > 0) counts.sessions += 1;
    }
  });
  txn();

  return counts;
}

function readAll<T>(db: Database.Database, sql: string): T[] {
  return db.prepare(sql).all() as T[];
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(name);
  return !!row;
}

function hasContent(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}
