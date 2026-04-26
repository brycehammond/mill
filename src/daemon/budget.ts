import type { StageName, StateStore } from "../core/index.js";

// Phase 3 budget enforcement.
//
// Two surfaces:
//   - `checkPreflight` runs at run creation time (POST /projects/:id/runs)
//     — if the project's monthly spend already meets-or-exceeds the cap,
//     intake refuses and surfaces 402.
//   - `checkInflight` is called from claude-cli.ts after every `addStageCost`
//     delta. It updates the run's paused_budget status and emits a
//     `budget_warning_80` event the first time spend crosses 80% of the cap
//     in a calendar month. The check is intentionally NOT inside
//     core/store.sqlite.ts to avoid pulling daemon-layer logic into the
//     core layer. claude-cli.ts already has a hook point right after the
//     cost increment lands; that's the right place to call this.
//
// Budget month boundary is calendar month UTC. Predictable, matches every
// billing system. Warning idempotency is per-(project, month): the next
// month's first 80% crossing emits a fresh warning.

export interface PreflightOk {
  ok: true;
}

export interface PreflightDenied {
  ok: false;
  status: 402;
  reason: string;
  currentSpend: number;
  budget: number;
}

export type PreflightResult = PreflightOk | PreflightDenied;

export interface InflightResult {
  paused: boolean;
  warned80: boolean;
}

// Start-of-current-calendar-month UTC, in unix ms. Used to filter
// `runs.created_at` for the monthly aggregate. Pure for a given `now`
// so tests can pin month boundaries without mocking Date.
export function startOfMonthUtc(now: Date = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

// Sum of total_cost_usd across all of a project's runs created in the
// current calendar month UTC. Cancelled / failed / killed runs still
// count — the cost was already incurred. listRuns returns all statuses
// when no filter is set; we ignore status here on purpose.
export function monthlySpendUsd(
  store: StateStore,
  projectId: string,
  now: Date = new Date(),
): number {
  const monthStart = startOfMonthUtc(now);
  const runs = store.listRuns({ projectId, limit: 100_000 });
  let total = 0;
  for (const r of runs) {
    if (r.created_at >= monthStart) total += r.total_cost_usd;
  }
  return total;
}

// Pre-flight: would creating a new run be over the cap right now?
// `null` / `0` budget means "unlimited" — explicit unlimited is the
// default for projects that didn't set a cap.
export function checkPreflight(
  store: StateStore,
  projectId: string,
  now: Date = new Date(),
): PreflightResult {
  const project = store.getProject(projectId);
  if (!project) {
    return { ok: true };
  }
  const budget = project.monthly_budget_usd;
  if (budget === null || budget <= 0) {
    return { ok: true };
  }
  const spend = monthlySpendUsd(store, projectId, now);
  if (spend >= budget) {
    return {
      ok: false,
      status: 402,
      reason:
        `project ${project.name} is over its monthly budget ` +
        `($${spend.toFixed(2)} / $${budget.toFixed(2)}). ` +
        `Raise the cap or wait until next month.`,
      currentSpend: spend,
      budget,
    };
  }
  return { ok: true };
}

// In-flight: called from the claude-cli streaming loop right after each
// cost delta is committed. Fires two side effects when applicable:
//   1. Cross 80% (and not already warned this month) → append
//      `budget_warning_80` event. Idempotent via an existence check on
//      the events table.
//   2. Cross 100% → append `budget_exceeded`, flip the run to
//      `paused_budget`. The pipeline's between-stage check unwinds at
//      the next stage boundary via BudgetPausedError.
//
// The `runId` is needed because all events live in the per-run events
// table; for project-scoped warnings we still tie them to the run that
// caused the crossing (so the UI's run timeline shows it).
export function checkInflight(
  store: StateStore,
  projectId: string,
  runId: string,
  stage: StageName,
  now: Date = new Date(),
): InflightResult {
  const project = store.getProject(projectId);
  if (!project) return { paused: false, warned80: false };
  const budget = project.monthly_budget_usd;
  if (budget === null || budget <= 0) {
    return { paused: false, warned80: false };
  }
  const spend = monthlySpendUsd(store, projectId, now);

  let warned80 = false;
  if (spend >= budget * 0.8 && spend < budget) {
    if (!hasWarningInMonth(store, projectId, now)) {
      store.appendEvent(runId, stage, "budget_warning_80", {
        project_id: projectId,
        project_name: project.name,
        current_spend_usd: spend,
        budget_usd: budget,
        threshold_pct: 80,
      });
      warned80 = true;
    }
  }

  let paused = false;
  if (spend >= budget) {
    const run = store.getRun(runId);
    if (run && run.status !== "paused_budget") {
      store.appendEvent(runId, stage, "budget_exceeded", {
        project_id: projectId,
        project_name: project.name,
        current_spend_usd: spend,
        budget_usd: budget,
      });
      store.updateRun(runId, { status: "paused_budget" });
      paused = true;
    }
  }

  return { paused, warned80 };
}

// One `budget_warning_80` per project per calendar month is the bar.
// We scan recent events on any run of this project (cheap — the listRuns
// already filtered to current-month runs upstream, but here we're called
// from a fresh inflight context, so we look at every run in the month).
function hasWarningInMonth(
  store: StateStore,
  projectId: string,
  now: Date,
): boolean {
  const monthStart = startOfMonthUtc(now);
  const runs = store.listRuns({ projectId, limit: 100_000 });
  for (const r of runs) {
    if (r.created_at < monthStart) continue;
    const events = store.tailEvents(r.id, 0, 10_000);
    for (const e of events) {
      if (e.kind === "budget_warning_80" && e.ts >= monthStart) return true;
    }
  }
  return false;
}
