// Wire types — duplicates of the daemon's row shapes. We don't share
// the server types here because the server bundle isn't a dep of this
// package; if a field drifts, the typecheck will catch it via the
// adapter functions in api.ts.

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type RunStatus =
  | "queued"
  | "awaiting_clarification"
  | "running"
  | "completed"
  | "failed"
  | "killed";
export type RunMode = "new" | "edit";
export type CriticName =
  | "security"
  | "correctness"
  | "ux"
  | "adversarial"
  | "tests";
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
export type StageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface Project {
  id: string;
  name: string;
  root_path: string;
  added_at: number;
  removed_at: number | null;
  monthly_budget_usd: number | null;
  default_concurrency: number | null;
  cost_today_usd: number;
  cost_mtd_usd: number;
  in_flight_runs: number;
  last_delivery_ts: number | null;
}

export interface Run {
  id: string;
  project_id: string | null;
  status: RunStatus;
  kind: string | null;
  mode: RunMode;
  created_at: number;
  requirement_path: string;
  spec_path: string | null;
  test_command: string | null;
  total_cost_usd: number;
  total_input_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_output_tokens: number;
}

export interface DisplayStage {
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

export interface RunDetail {
  run: Run;
  stages: DisplayStage[];
  findings_counts: Record<Severity, number> & { total: number };
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  why: string;
  default?: string;
}

export interface Clarifications {
  kind: string;
  questions: ClarificationQuestion[];
  answers?: Record<string, string>;
}

export interface CreateRunResponse {
  run_id: string;
  mode: RunMode;
  branch: string | null;
  base_branch: string | null;
  status: RunStatus;
  clarifications: Clarifications | null;
}

export interface LedgerEntry {
  fingerprint: string;
  critic: CriticName;
  severity: Severity;
  title: string;
  runCount: number;
  occurrenceCount: number;
  firstSeen: number;
  lastSeen: number;
  suppressed: boolean;
  exampleDetailPath: string | null;
}

export interface SuppressedEntry {
  fingerprint: string;
  added_at: number;
  note: string | null;
}

export interface Dashboard {
  cost_today_usd: number;
  cost_mtd_usd: number;
  runs_in_flight: number;
  project_count: number;
  projects: Array<{
    id: string;
    name: string;
    root_path: string;
    cost_today_usd: number;
    cost_mtd_usd: number;
    in_flight_runs: number;
    last_delivery_ts: number | null;
    last_run_status: RunStatus | null;
  }>;
  top_recurring_findings: LedgerEntry[];
}

export interface WireEvent {
  id: number;
  run_id: string;
  stage: StageName;
  ts: number;
  kind: string;
  payload: unknown;
}
