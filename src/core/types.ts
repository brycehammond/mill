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
  | "killed"
  // Phase 3: graceful pause at a stage boundary because the project's
  // monthly_budget_usd was crossed mid-stage. Resumable via
  // POST /api/v1/runs/:id/resume once the project is back under budget.
  | "paused_budget"
  // Phase 3: graceful pause at a stage boundary because the next stage
  // is listed in `project_approval_gates`. Resumable via approve/reject.
  | "awaiting_approval";

// Phase 3 event kinds. These are string literals carried in events.kind;
// listing them here keeps the names canonical across the daemon, the
// pipeline, the webhook worker, and the UI. Existing kinds (stage_started,
// stage_completed, branch_imported, remediation, etc.) are not enumerated
// and remain free-form strings.
export type Phase3EventKind =
  | "budget_warning_80"
  | "budget_exceeded"
  | "approval_required"
  | "approval_granted"
  | "approval_rejected"
  | "webhook_disabled";

// Reason a run landed in `failed` status. Stored on `runs.failure_reason`.
// Free-form string column; these are the canonical values today.
export type RunFailureReason = "rejected" | "budget" | "error";

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
  // Phase 3: name of the next stage that is gated by an approval rule.
  // Set when status transitions to `awaiting_approval`; cleared on
  // approve / reject / resume.
  awaiting_approval_at_stage: StageName | null;
  // Phase 3: why the run is in `failed` status. Free-form string today;
  // canonical values are RunFailureReason ("rejected" | "budget" | "error").
  failure_reason: string | null;
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
  // Phase 3: who caused this event. Stage events use 'mill'; user-driven
  // events (approve / reject / kill / project add / etc.) carry the
  // authenticated session's user identifier (or `MILL_USER` when running
  // unauthenticated locally).
  actor: string;
  payload_json: string;
}

// Phase 3: cookie-backed UI session. The auth.ts module stores HMAC-of-id
// in the cookie itself; this row is the durable record. `actor` is the
// free-form name the user typed at login (or the deployment's `MILL_USER`
// fallback); it lands on user-driven events for audit.
export interface AuthSessionRow {
  id: string;
  actor: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

// Phase 3: outbound webhook subscription, scoped to a single project.
// `event_filter` is a comma-separated list of event names ("run.completed",
// "finding.high", etc.). `enabled = 0` disables delivery without deleting
// the row (auto-set after consecutive_failures crosses the threshold).
export interface ProjectWebhookRow {
  id: string;
  project_id: string;
  url: string;
  event_filter: string;
  secret: string;
  enabled: boolean;
  consecutive_failures: number;
  created_at: number;
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

// Project-scoped lifetime aggregates. Powers the project report page —
// one row, derived from `runs` + `stages`. Counts are for the project's
// entire history; cost/token totals sum across every run.
export interface ProjectReportAggregates {
  total_runs: number;
  by_status: Record<RunStatus, number>;
  by_mode: Record<RunMode, number>;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  // total_cost_usd / total_runs, or 0 when total_runs == 0.
  avg_cost_usd: number;
  first_run_at: number | null;
  last_run_at: number | null;
  // Average end-to-end run duration in ms. Derived from
  // max(stages.finished_at) - run.created_at across runs that have at
  // least one finished stage. Null when no run has finished a stage.
  avg_duration_ms: number | null;
  // completed / (completed + failed + killed). Null when denominator is 0
  // (no terminal-state runs yet).
  success_rate: number | null;
}

// Calendar-month rollup of cost + run count. Months returned in
// chronological order. Months with no activity are still included so the
// UI can render a stable timeline (zero-cost rows for gaps).
export interface ProjectCostByMonth {
  month: string; // "YYYY-MM" UTC
  cost_usd: number;
  run_count: number;
}

// Per-stage rollup across the project's lifetime. One row per stage in
// STAGE_ORDER (zeros for stages never run, so the UI table is stable).
export interface ProjectStageRollup {
  name: StageName;
  // Total cost for this stage across every run that touched it.
  total_cost_usd: number;
  // Distinct runs whose `stages` row exists for this stage (any status).
  total_runs: number;
  completed: number;
  failed: number;
  // Average duration of (finished_at - started_at) across completed
  // stage rows. Null when no completed row has both timestamps.
  avg_duration_ms: number | null;
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
      | "awaiting_approval_at_stage"
      | "failure_reason"
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
  ): void;
  setRunProjectId(id: string, projectId: string): void;
  addRunCost(id: string, delta: number): void;
  addRunUsage(id: string, usage: TokenUsage): void;
  listRuns(opts?: {
    status?: RunStatus;
    limit?: number;
    projectId?: string;
  }): RunRow[];

  // Lifetime aggregates for the project report page. Single SQL pass
  // over runs + stages; safe to call on the request path.
  getProjectReportAggregates(projectId: string): ProjectReportAggregates;
  // Last `months` calendar months UTC, oldest first. Includes zero-cost
  // rows for months with no runs so the UI gets a contiguous timeline.
  getProjectCostByMonth(projectId: string, months: number): ProjectCostByMonth[];
  // One row per stage in STAGE_ORDER (zero-filled when the stage was
  // never run for this project), so the UI can render a stable table.
  getProjectStageRollups(projectId: string): ProjectStageRollup[];

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

  // `actor` defaults to 'mill'. Pass an explicit identifier for user-
  // driven events (kill, approve, reject, resume, project add/rm, etc.).
  appendEvent(
    runId: string,
    stage: StageName,
    kind: string,
    payload: unknown,
    actor?: string,
  ): void;
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

  // ---- Phase 3: auth sessions ----
  // Cookie-backed UI sessions. The Bearer-token path on CLI requests does
  // not touch this table. Stored under `auth_sessions` to avoid colliding
  // with the existing per-run-stage `sessions` table.
  createAuthSession(row: {
    id: string;
    actor: string;
    created_at?: number;
    last_seen_at?: number;
    expires_at: number;
  }): AuthSessionRow;
  // Returns null when not found OR when the row is past its expires_at.
  // Expired rows stay on disk until deleteExpiredSessions sweeps them.
  findAuthSession(id: string): AuthSessionRow | null;
  // Slide expiry: bump last_seen_at and (optionally) push expires_at out.
  // Returns the updated row or null if the session no longer exists / is
  // already expired.
  touchAuthSession(id: string, newExpiresAt: number): AuthSessionRow | null;
  deleteAuthSession(id: string): void;
  deleteAllAuthSessions(): void;
  deleteExpiredAuthSessions(now?: number): number;

  // ---- Phase 3: approval gates ----
  // Per-project list of stage names; a row means "pause runs in this
  // project after the named stage completes; require explicit approval to
  // continue." setProjectGates is a full replace; clearProjectGates wipes
  // all rows for the project. listProjectGates returns the stage names.
  setProjectGates(projectId: string, stages: StageName[]): void;
  clearProjectGates(projectId: string): void;
  listProjectGates(projectId: string): StageName[];

  // ---- Phase 3: webhooks ----
  createWebhook(row: {
    id: string;
    project_id: string;
    url: string;
    event_filter: string;
    secret: string;
    enabled?: boolean;
    created_at?: number;
  }): ProjectWebhookRow;
  listWebhooksByProject(projectId: string): ProjectWebhookRow[];
  // Subset of listWebhooksByProject filtered to enabled rows whose
  // event_filter contains the given event name. Used by the notify
  // worker on every event publish.
  listWebhooksByEvent(projectId: string, eventName: string): ProjectWebhookRow[];
  getWebhook(id: string): ProjectWebhookRow | null;
  deleteWebhook(id: string): void;
  // Increment / read consecutive_failures atomically. Returns the new
  // count so the worker can decide whether to disable the webhook.
  incWebhookFailures(id: string): number;
  resetWebhookFailures(id: string): void;
  disableWebhook(id: string): void;

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
