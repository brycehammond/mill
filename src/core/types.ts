// Load-bearing type surface for the mill pipeline.

export type Kind = "ui" | "backend" | "cli";

export type RunMode = "new" | "edit";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const SEVERITY_ORDER: Record<Severity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export function atLeast(a: Severity, b: Severity): boolean {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b];
}

export type StageName =
  | "intake"
  | "clarify"
  | "spec"
  | "design"
  | "spec2tests"
  | "implement"
  | "review"
  | "verify"
  | "deliver"
  | "decisions";

export const STAGE_ORDER: StageName[] = [
  "intake",
  "clarify",
  "spec",
  "design",
  "spec2tests",
  "implement",
  "review",
  "verify",
  "deliver",
  "decisions",
];

export type RunStatus =
  | "queued"
  | "awaiting_clarification"
  | "running"
  | "completed"
  | "failed"
  | "killed";

export type StageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type CriticName =
  | "security"
  | "correctness"
  | "ux"
  | "adversarial"
  | "tests";

export const CRITIC_NAMES: CriticName[] = [
  "security",
  "correctness",
  "ux",
  "adversarial",
  "tests",
];

// Raw token counts from a single `claude` invocation. Fields mirror the
// `usage` object on a `result` stream event. All four are additive —
// cache_read_input_tokens overlap conceptually with input_tokens
// budget-wise but are cheap and billed separately, so we keep them apart.
export interface TokenUsage {
  input: number;
  cache_creation: number;
  cache_read: number;
  output: number;
}

export const ZERO_USAGE: TokenUsage = {
  input: 0,
  cache_creation: 0,
  cache_read: 0,
  output: 0,
};

export interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  added_at: number;
  removed_at: number | null;
  monthly_budget_usd: number | null;
  default_concurrency: number | null;
}

export interface RunRow {
  id: string;
  // Foreign key to projects.id. Nullable for legacy rows imported from a
  // pre-multi-project DB before backfill, or rows created before the
  // schema migration ran.
  project_id: string | null;
  status: RunStatus;
  kind: Kind | null;
  mode: RunMode;
  created_at: number;
  requirement_path: string;
  spec_path: string | null;
  // Resolved test command for the run — written by spec2tests when it
  // scaffolds or re-uses a runner. Tests critic prefers this over the
  // project profile. Null when spec2tests didn't run / couldn't.
  test_command: string | null;
  total_cost_usd: number;
  total_input_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_output_tokens: number;
}

export interface StageRow {
  run_id: string;
  name: StageName;
  status: StageStatus;
  started_at: number | null;
  finished_at: number | null;
  cost_usd: number;
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  session_id: string | null;
  artifact_path: string | null;
  error: string | null;
}

// Per-iteration stage row. Sibling table to `stages` — written only by
// the implement ⇄ review loop. Cumulative `stages` rows continue to roll
// up across iterations; this table preserves per-iteration detail so
// `mill status` / progress ticker can show one row per iteration.
export interface StageIterationRow {
  run_id: string;
  stage_name: StageName;
  iteration: number;
  status: StageStatus;
  started_at: number | null;
  finished_at: number | null;
  cost_usd: number;
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  session_id: string | null;
  artifact_path: string | null;
  error: string | null;
}

// Unified row consumed by display surfaces (`mill status`, progress
// ticker). For non-iterating stages or runs without iteration data,
// `iteration` is null and `displayName` is just the stage name. For
// iterating stages with ≥2 iteration rows, one DisplayStageRow per
// iteration is emitted with displayName like `implement #2`.
export interface DisplayStageRow {
  run_id: string;
  name: StageName;
  displayName: string;
  iteration: number | null;
  status: StageStatus;
  started_at: number | null;
  finished_at: number | null;
  cost_usd: number;
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  session_id: string | null;
  artifact_path: string | null;
  error: string | null;
}

export interface EventRow {
  id: number;
  run_id: string;
  stage: StageName;
  ts: number;
  kind: string;
  payload_json: string;
}

export interface FindingRow {
  id: number;
  run_id: string;
  iteration: number;
  critic: CriticName;
  severity: Severity;
  title: string;
  detail_path: string;
  fingerprint: string;
}

// Aggregated view across runs. One row per fingerprint.
export interface LedgerEntry {
  fingerprint: string;
  critic: CriticName;
  severity: Severity;
  title: string;
  runCount: number;       // distinct runs that flagged this fingerprint
  occurrenceCount: number; // total finding rows (includes re-reviews within a run)
  firstSeen: number;       // ts of earliest run that flagged it
  lastSeen: number;        // ts of latest run that flagged it
  suppressed: boolean;
  exampleDetailPath: string | null; // path to the most-recent detail report
}

export interface Finding {
  critic: CriticName;
  severity: Severity;
  title: string;
  evidence: string;
  suggested_fix: string;
}

// Canonical fingerprint for a finding. Same format is used by:
// - the review loop's "stuck" detection (findings from iter N are a
//   subset of iter N-1's)
// - the cross-run ledger (recurring issues across runs)
// - the suppression list (noise / known false positives)
// Must remain stable: older rows in the `findings` table are
// fingerprinted with this exact function via migration.
export function findingFingerprint(
  f: Pick<Finding, "critic" | "severity" | "title">,
): string {
  return `${f.critic}|${f.severity}|${f.title.trim().toLowerCase()}`;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  why: string;
  default?: string;
}

export interface Clarifications {
  kind: Kind;
  questions: ClarificationQuestion[];
  answers?: Record<string, string>;
}

export interface RunPaths {
  root: string;
  runDir: string;
  requirement: string;
  clarifications: string;
  spec: string;
  designDir: string;
  designIntent: string;
  architecture: string;
  stitchUrl: string;
  designScreens: string;
  workdir: string;
  reviewsDir: string;
  verifyDir: string;
  delivery: string;
  killed: string;
  events: string;
}

export interface StageResult {
  ok: boolean;
  cost?: number;
  error?: string;
  data?: unknown;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

// Concrete interface for the stage-level context. Held constant for a run;
// `kind` is populated after the clarify stage classifies the requirement.
export interface RunContext {
  runId: string;
  // Identifier of the project this run belongs to. Resolved at intake;
  // never changes for the lifetime of a run.
  projectId: string;
  kind: Kind | null;
  mode: RunMode;
  paths: RunPaths;
  store: StateStore;
  abortController: AbortController;
  costs: CostTracker;
  logger: Logger;
  model: string | undefined;
  // Project repo root — where workdirs live, where git operates. Stays
  // inside the registered repo so CLAUDE.md auto-discovery and worktrees
  // keep working. Distinct from `stateDir` (central per-project state).
  root: string;
  // Central per-project state directory (`~/.mill/projects/<id>/`).
  // Holds journal.md, decisions.md, profile.json, stitch.json — files
  // that travel with the project registration, not with the workdir.
  stateDir: string;
  // Default wall-clock cap for a single `claude` subprocess. Stages override
  // per-call; if neither, runClaude uses this. Milliseconds.
  stageTimeoutMs: number;
  // Per-stage timeout overrides (milliseconds). Stages not listed fall back
  // to stageTimeoutMs. implement/verify get longer budgets by default because
  // a from-scratch build genuinely needs more than 10 minutes.
  stageTimeoutsMs: Partial<Record<StageName, number>>;
}

export interface StateStore {
  init(): void;
  close(): void;

  // Run `fn` inside a single SQLite transaction. Used at stage boundaries to
  // commit cost tally + session id + finishStage atomically, so a crash in
  // between doesn't double-bill on resume.
  transaction<T>(fn: () => T): T;

  // ---- projects ----

  addProject(row: {
    id: string;
    name: string;
    root_path: string;
    added_at?: number;
    monthly_budget_usd?: number | null;
    default_concurrency?: number | null;
  }): ProjectRow;
  getProject(id: string): ProjectRow | null;
  getProjectByPath(rootPath: string): ProjectRow | null;
  getProjectByName(name: string): ProjectRow | null;
  listProjects(opts?: { includeRemoved?: boolean }): ProjectRow[];
  removeProject(id: string): void;
  updateProjectBudget(id: string, monthlyBudgetUsd: number | null): void;
  updateProjectConcurrency(id: string, defaultConcurrency: number | null): void;

  // ---- runs ----

  createRun(
    row: Omit<
      RunRow,
      | "total_cost_usd"
      | "total_input_tokens"
      | "total_cache_creation_tokens"
      | "total_cache_read_tokens"
      | "total_output_tokens"
      | "spec_path"
      | "mode"
      | "test_command"
      | "project_id"
    > & {
      spec_path?: string | null;
      mode?: RunMode;
      test_command?: string | null;
      project_id?: string | null;
    },
  ): void;
  getRun(id: string): RunRow | null;
  updateRun(
    id: string,
    patch: Partial<
      Pick<RunRow, "status" | "kind" | "spec_path" | "test_command" | "total_cost_usd">
    >,
  ): void;
  setRunProjectId(id: string, projectId: string): void;
  addRunCost(id: string, delta: number): void;
  addRunUsage(id: string, usage: TokenUsage): void;
  listRuns(opts?: {
    status?: RunStatus;
    limit?: number;
    projectId?: string;
  }): RunRow[];

  startStage(runId: string, name: StageName): void;
  finishStage(
    runId: string,
    name: StageName,
    patch: Partial<Omit<StageRow, "run_id" | "name">>,
  ): void;
  // Incremental accumulators for the stage row. Used by runClaude so that a
  // SIGTERM mid-stream still leaves accurate cost/usage/session on disk. The
  // caller's finishStage only sets terminal fields (status, error, artifact).
  addStageCost(runId: string, name: StageName, delta: number): void;
  addStageUsage(runId: string, name: StageName, usage: TokenUsage): void;
  setStageSession(runId: string, name: StageName, sessionId: string): void;
  getStage(runId: string, name: StageName): StageRow | null;
  listStages(runId: string): StageRow[];

  // Per-iteration sibling rows for the implement ⇄ review loop. Mirror
  // the cumulative stage methods 1:1. runClaude double-writes when an
  // `iteration` is set so cumulative `stages.cost_usd` always equals
  // SUM(stage_iterations.cost_usd) for that stage.
  startStageIteration(runId: string, name: StageName, iteration: number): void;
  finishStageIteration(
    runId: string,
    name: StageName,
    iteration: number,
    patch: Partial<Omit<StageIterationRow, "run_id" | "stage_name" | "iteration">>,
  ): void;
  addStageIterationCost(runId: string, name: StageName, iteration: number, delta: number): void;
  addStageIterationUsage(
    runId: string,
    name: StageName,
    iteration: number,
    usage: TokenUsage,
  ): void;
  setStageIterationSession(
    runId: string,
    name: StageName,
    iteration: number,
    sessionId: string,
  ): void;
  getStageIteration(
    runId: string,
    name: StageName,
    iteration: number,
  ): StageIterationRow | null;
  listStageIterations(runId: string, name?: StageName): StageIterationRow[];

  // Merged view: cumulative `stages` rows expanded to per-iteration
  // rows for `implement` / `review` when the sibling table has data,
  // otherwise the cumulative row unchanged. Sorted chronologically.
  listDisplayStages(runId: string): DisplayStageRow[];

  appendEvent(runId: string, stage: StageName, kind: string, payload: unknown): void;
  tailEvents(runId: string, afterId?: number, limit?: number): EventRow[];

  insertFinding(row: Omit<FindingRow, "id" | "fingerprint">): void;
  listFindings(runId: string, opts?: { iteration?: number }): FindingRow[];

  // Cross-run aggregation. `minRuns` filters out singletons when
  // >1 — used by `mill findings` and by the edit-mode prompt injection.
  listLedgerEntries(opts?: {
    minRuns?: number;
    includeSuppressed?: boolean;
    limit?: number;
  }): LedgerEntry[];
  suppressFingerprint(fingerprint: string, note?: string): void;
  unsuppressFingerprint(fingerprint: string): void;
  listSuppressedFingerprints(): { fingerprint: string; added_at: number; note: string | null }[];

  saveClarifications(runId: string, c: Clarifications): void;
  getClarifications(runId: string): Clarifications | null;

  // Session slot is logical: stage name, or a sub-key like `review:security`.
  saveSession(
    runId: string,
    slot: string,
    sessionId: string,
    totalCostUsd: number,
  ): void;
  getSession(
    runId: string,
    slot: string,
  ): { sessionId: string; totalCostUsd: number } | null;
}

// Pure cost/token tally — no caps. The harness streams cumulative cost
// from each `claude` result message into here for reporting (delivery,
// pipeline summary). Auth is via Claude subscription, so there is no
// per-run dollar ceiling to enforce.
export interface CostTracker {
  addCost(stage: StageName, cost: number): void;
  addUsage(stage: StageName, usage: TokenUsage): void;
  runTotal(): number;
  stageTotal(stage: StageName): number;
  runUsageTotal(): TokenUsage;
  stageUsageTotal(stage: StageName): TokenUsage;
  snapshot(): {
    run: number;
    byStage: Partial<Record<StageName, number>>;
    runUsage: TokenUsage;
    byStageUsage: Partial<Record<StageName, TokenUsage>>;
  };
}

export class KilledError extends Error {
  constructor(runId: string) {
    super(`run ${runId} killed by sentinel`);
  }
}
