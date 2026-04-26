import type { Finding, RunContext, StageName, StageResult } from "../core/index.js";
import {
  atLeast,
  KilledError,
  killedSentinelExists,
  STAGE_ORDER,
} from "../core/index.js";
import { buildContext } from "./context.js";
import { loadConfig, type MillConfig } from "./config.js";
import { clarify } from "./stages/clarify.js";
import { spec } from "./stages/spec.js";
import { design } from "./stages/design.js";
import { spec2tests } from "./stages/spec2tests.js";
import { implement } from "./stages/implement.js";
import { review, shouldStopReviewLoop } from "./stages/review.js";
import { verify } from "./stages/verify.js";
import { deliver } from "./stages/deliver.js";
import { decisions } from "./stages/decisions.js";

// Phase 3: paired with KilledError, two more graceful-pause signals
// that unwind the pipeline at a stage boundary without flipping the run
// to `failed`. The pipeline catches both at the top level and leaves the
// run in its paused state — resumable via approve/resume.
export class BudgetPausedError extends Error {
  constructor(runId: string) {
    super(`run ${runId} paused: monthly budget exceeded`);
    this.name = "BudgetPausedError";
  }
}

export class ApprovalRequiredError extends Error {
  constructor(runId: string, public readonly atStage: StageName) {
    super(`run ${runId} awaiting approval before stage ${atStage}`);
    this.name = "ApprovalRequiredError";
  }
}

export interface RunPipelineArgs {
  runId: string;
  config?: MillConfig;
  ctx?: RunContext;
  // If set, return after the named stage completes successfully.
  // Used by `mill new --stop-after <stage>` to halt early so the user
  // can review before paying for the rest. Resume via `mill run <id>`
  // (no stopAfter) finishes the pipeline.
  stopAfter?: StageName;
}

export interface PipelineResult {
  runId: string;
  status: "completed" | "failed" | "killed" | "planned";
  reason?: string;
  costUsd: number;
  durationMs: number;
}

// Top-level driver: picks up at whichever stage was last incomplete. Each
// stage is its own try/catch so one failure records and surfaces cleanly
// without leaking stack traces upward.
export async function runPipeline(args: RunPipelineArgs): Promise<PipelineResult> {
  const config = args.config ?? loadConfig();
  const ctx = args.ctx ?? (await buildContext({ runId: args.runId, config }));
  const startedAt = Date.now();
  const runTimer = setTimeout(() => ctx.abortController.abort(), config.timeoutSecPerRun * 1000);

  ctx.logger.info("pipeline start", { stages: "spec→design→implement⇄review→verify→deliver" });

  const stopAfter = args.stopAfter;
  const plannedStop = (stage: StageName): PipelineResult | null => {
    if (stopAfter !== stage) return null;
    const costUsd = ctx.costs.runTotal();
    const durationMs = Date.now() - startedAt;
    ctx.logger.info("pipeline stopped after stage (plan mode)", { stage });
    return {
      runId: ctx.runId,
      status: "planned",
      reason: `stopped after ${stage} (plan mode — resume with \`mill run ${ctx.runId}\`)`,
      costUsd,
      durationMs,
    };
  };

  try {
    // 1. spec
    if (needsStage(ctx, "spec")) {
      const r = await spec(ctx);
      enforceBetweenStages(ctx, r, "spec", "spec");
    }
    {
      const planned = plannedStop("spec");
      if (planned) return planned;
    }

    // 2. design
    if (needsStage(ctx, "design")) {
      // refresh kind from store (set by clarify)
      const run = ctx.store.getRun(ctx.runId);
      ctx.kind = run?.kind ?? ctx.kind;
      const r = await design(ctx);
      enforceBetweenStages(ctx, r, "design", "design");
    }
    {
      const planned = plannedStop("design");
      if (planned) return planned;
    }

    // 3. spec2tests (optional; gated on profile + MILL_SPEC2TESTS)
    if (needsStage(ctx, "spec2tests")) {
      if (await shouldRunSpec2Tests(ctx)) {
        const r = await spec2tests(ctx);
        enforceBetweenStages(ctx, r, "spec2tests", "spec2tests");
      } else {
        ctx.store.finishStage(ctx.runId, "spec2tests", {
          status: "skipped",
          artifact_path: null,
        });
      }
    }
    {
      const planned = plannedStop("spec2tests");
      if (planned) return planned;
    }

    // 4. implement ⇄ review loop
    let previousHigh: Finding[] = [];
    let currentHigh: Finding[] = [];
    let allHigh: Finding[] = [];
    let stopReason = "";

    // Resume awareness: when a prior `mill run` got partway through, the
    // sibling per-iteration rows in `stage_iterations` tell us exactly
    // which iterations completed. We resume from the iteration after
    // the last fully-completed `review` row. Old runs without sibling
    // data fall back to `highestIterationWithFindings`.
    let iteration = resumeIteration(ctx);
    if (iteration > 0) {
      ctx.logger.info("review loop resume: skipping completed iterations", {
        iterations: iteration,
      });
      // Seed previousHigh from the resume-iteration findings so the
      // next implement call gets the right prior-findings prompt.
      previousHigh = findingsAtIterationAsHigh(ctx, iteration);
      currentHigh = previousHigh;
      allHigh = currentHigh;
    }

    while (iteration < config.maxReviewIters) {
      iteration += 1;
      ctx.logger.info("implement iteration", { iteration });

      // Per-iteration crash recovery: if a previous run already
      // completed implement#N and review#N, skip them on this resume.
      // implement#N completed but review#N didn't → resume from review.
      const implRow = ctx.store.getStageIteration(
        ctx.runId,
        "implement",
        iteration,
      );
      if (!implRow || implRow.status !== "completed") {
        const implResult = await implement({
          ctx,
          iteration,
          priorFindings: previousHigh,
        });
        // Inside the iteration loop we only check kill / fail / budget,
        // not approval gates. Gating between implement#N and review#N
        // (or between iterations) doesn't fit the user-facing model —
        // the gate at "review" fires once after the loop exits.
        enforceBetweenStages(ctx, implResult, `implement-${iteration}`);
      }

      const revRow = ctx.store.getStageIteration(
        ctx.runId,
        "review",
        iteration,
      );
      let revResult: Awaited<ReturnType<typeof review>>;
      if (!revRow || revRow.status !== "completed") {
        revResult = await review({ ctx, iteration });
        enforceBetweenStages(ctx, revResult, `review-${iteration}`);
      } else {
        revResult = rebuildReviewResultFromFindings(ctx, iteration);
      }
      currentHigh = revResult.data.highFindings;
      allHigh = currentHigh;

      const stop = shouldStopReviewLoop({
        iteration,
        maxIters: config.maxReviewIters,
        currentHigh,
        previousHigh,
      });
      if (stop.stop) {
        stopReason = stop.reason;
        ctx.logger.info("review loop stop", {
          iteration,
          reason: stop.reason,
          high: currentHigh.length,
        });
        break;
      }
      previousHigh = currentHigh;
    }

    // Boundary check between the review loop and verify. `review` is
    // the just-completed stage; the gate would be on the next stage
    // (`verify`). The result we pass is always-ok because we only
    // arrive here from a clean loop exit.
    enforceBetweenStages(
      ctx,
      { ok: true },
      `review-${iteration}-loop-end`,
      "review",
    );

    // 4. verify
    const verifyResult = await verify(ctx);
    enforceBetweenStages(ctx, verifyResult, "verify", "verify");

    // 5. deliver
    await deliver({
      ctx,
      iterationCount: iteration,
      unresolvedHighFindings: allHigh,
      verifyPass: verifyResult.ok,
      verifyReportPath: `${ctx.paths.verifyDir}/report.md`,
      endedAt: Date.now(),
      startedAt,
    });

    // 6. decisions — best-effort ADR extraction. The `decisions` stage
    // catches its own errors and never fails the run; a stage row is
    // still written so crash recovery doesn't rerun it.
    if (needsStage(ctx, "decisions")) {
      await decisions({ ctx });
    }

    const finalRun = ctx.store.getRun(ctx.runId);
    const costUsd = finalRun?.total_cost_usd ?? ctx.costs.runTotal();
    const durationMs = Date.now() - startedAt;
    const passed = verifyResult.ok && allHigh.length === 0;

    return {
      runId: ctx.runId,
      status: passed ? "completed" : "failed",
      reason: passed ? stopReason || "ok" : `verify=${verifyResult.ok} unresolvedHigh=${allHigh.length}`,
      costUsd,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const costUsd = ctx.costs.runTotal();
    if (err instanceof KilledError) {
      ctx.store.updateRun(ctx.runId, { status: "killed" });
      ctx.logger.warn("pipeline killed", { reason: err.message });
      // Phase 3: emit a terminal event so the notify worker fans out
      // a run.killed webhook. Failures here must not change the run
      // status — the kill already happened.
      try {
        ctx.store.appendEvent(ctx.runId, "deliver", "run_killed", {
          run_id: ctx.runId,
          summary: "Run killed by user",
          reason: err.message,
        });
      } catch {
        // ignore
      }
      return {
        runId: ctx.runId,
        status: "killed",
        reason: err.message,
        costUsd,
        durationMs,
      };
    }
    if (err instanceof BudgetPausedError) {
      // Already flipped to paused_budget by the inflight check. Don't
      // overwrite with `failed`. The run row is its own source of truth.
      ctx.logger.warn("pipeline paused (budget)", { reason: err.message });
      return {
        runId: ctx.runId,
        status: "planned",
        reason: err.message,
        costUsd,
        durationMs,
      };
    }
    if (err instanceof ApprovalRequiredError) {
      // Already flipped to awaiting_approval by enforceBetweenStages.
      ctx.logger.info("pipeline paused (approval required)", {
        atStage: err.atStage,
      });
      return {
        runId: ctx.runId,
        status: "planned",
        reason: err.message,
        costUsd,
        durationMs,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.store.updateRun(ctx.runId, {
      status: "failed",
      failure_reason: "error",
    });
    ctx.logger.error("pipeline failed", { err: msg });
    // Phase 3: emit a terminal failure event for the notify worker.
    // Pipeline crashes that don't reach deliver land here; the deliver
    // stage emits its own terminal event when it's the source of the
    // failure, so the audit trail covers both paths.
    try {
      ctx.store.appendEvent(ctx.runId, "deliver", "run_failed", {
        run_id: ctx.runId,
        summary: "Run failed",
        reason: msg,
      });
    } catch {
      // ignore
    }
    return {
      runId: ctx.runId,
      status: "failed",
      reason: msg,
      costUsd,
      durationMs,
    };
  } finally {
    clearTimeout(runTimer);
  }
}

// Stage-boundary check. Three pause/abort signals follow the same shape:
//   - KILLED sentinel (hard, terminal — KilledError)
//   - paused_budget (graceful, resumable — BudgetPausedError)
//   - awaiting_approval (graceful, resumable — ApprovalRequiredError)
// Checks fire AFTER finishStage so the just-completed row is durable.
// `justCompleted` is the stage whose finishStage we just observed; the
// gate check looks at the project's gates for the NEXT non-iteration
// stage. Pass it in for major pipeline transitions; omit it (or pass
// undefined) for iteration-internal boundaries (e.g. between implement
// and review of the same iteration) where gating doesn't make sense.
function enforceBetweenStages(
  ctx: RunContext,
  r: StageResult,
  label: string,
  justCompleted?: StageName,
): void {
  if (killedSentinelExists(ctx.paths.killed)) {
    throw new KilledError(ctx.runId);
  }
  if (!r.ok) {
    throw new Error(`${label} failed: ${r.error ?? "unknown"}`);
  }
  // Phase 3: budget pause check. The inflight check inside claude-cli
  // already flipped runs.status to paused_budget when the cap crossed
  // mid-stage. We only need to read it here and unwind cleanly.
  const run = ctx.store.getRun(ctx.runId);
  if (run?.status === "paused_budget") {
    throw new BudgetPausedError(ctx.runId);
  }
  // Phase 3: approval-gate check. Look up the next pipeline stage in
  // STAGE_ORDER and ask the project whether it's gated.
  if (justCompleted) {
    const nextStage = nextPipelineStage(justCompleted);
    if (nextStage) {
      const gates = ctx.store.listProjectGates(ctx.projectId);
      if (gates.includes(nextStage)) {
        ctx.store.updateRun(ctx.runId, {
          status: "awaiting_approval",
          awaiting_approval_at_stage: nextStage,
        });
        ctx.store.appendEvent(ctx.runId, justCompleted, "approval_required", {
          next_stage: nextStage,
          completed_stage: justCompleted,
        });
        throw new ApprovalRequiredError(ctx.runId, nextStage);
      }
    }
  }
}

// Find the next stage after `current` in STAGE_ORDER. Returns null when
// `current` is the last stage. The order in types.ts already excludes
// the iteration-internal review/implement repeats; this is purely a
// lookup, not a state-aware traversal.
function nextPipelineStage(current: StageName): StageName | null {
  const i = STAGE_ORDER.indexOf(current);
  if (i < 0 || i >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[i + 1] ?? null;
}

// Highest iteration number that has any persisted findings. Kept as a
// fallback for resuming runs that predate the per-iteration `stage_iterations`
// table — in current runs, `resumeIteration` prefers those rows. Returns 0
// when no findings have been written.
function highestIterationWithFindings(ctx: RunContext): number {
  const all = ctx.store.listFindings(ctx.runId);
  let max = 0;
  for (const f of all) if (f.iteration > max) max = f.iteration;
  return max;
}

// Highest iteration where the `review` row reached `completed`. The
// loop resumes from this number — the next pass increments it before
// checking implement#N+1. Falls back to findings-based detection so
// runs that started before this feature shipped still resume cleanly.
function resumeIteration(ctx: RunContext): number {
  const reviews = ctx.store.listStageIterations(ctx.runId, "review");
  let max = 0;
  for (const r of reviews) {
    if (r.status === "completed" && r.iteration > max) max = r.iteration;
  }
  if (max > 0) return max;
  return highestIterationWithFindings(ctx);
}

// Reconstruct just enough of a ReviewOutput from the findings table to
// re-evaluate `shouldStopReviewLoop` on resume. The full ReviewOutput
// (summaries, reportPaths, cost) isn't needed downstream — only
// highFindings drives the loop's stop decision and the next implement's
// prior-findings prompt.
function rebuildReviewResultFromFindings(
  ctx: RunContext,
  iteration: number,
): Awaited<ReturnType<typeof review>> {
  const highFindings = findingsAtIterationAsHigh(ctx, iteration);
  return {
    ok: true,
    cost: 0,
    data: {
      findings: highFindings,
      highFindings,
      summaries: [],
      cost: 0,
      reportPaths: [],
    },
  };
}

function findingsAtIterationAsHigh(
  ctx: RunContext,
  iteration: number,
): Finding[] {
  return ctx.store
    .listFindings(ctx.runId, { iteration })
    .filter((f) => atLeast(f.severity, "HIGH"))
    .map((f) => ({
      critic: f.critic,
      severity: f.severity,
      title: f.title,
      // Detail body isn't persisted on the row; the next implement
      // doesn't need it — the title + severity + critic is what shows
      // up in its prompt anyway.
      evidence: "",
      suggested_fix: "",
    }));
}

function needsStage(ctx: RunContext, name: Parameters<typeof ctx.store.getStage>[1]): boolean {
  const row = ctx.store.getStage(ctx.runId, name);
  // `skipped` counts as terminal — no rerun on resume. Only `completed`
  // and `skipped` short-circuit.
  if (!row) return true;
  return row.status !== "completed" && row.status !== "skipped";
}

// Gate spec2tests: default-on in both modes. In edit mode the stage
// reuses the profile's test command; in new mode it bootstraps a
// runner. `MILL_SPEC2TESTS=off` skips the stage entirely — useful when
// the user is debugging a pipeline issue and doesn't want the cost of
// a test scaffold. The stage itself still handles the degenerate
// "nothing to test" case defensively.
//
// Note: readProfile is intentionally not consulted here anymore. The
// stage's prompt branches on profile presence; the pipeline just
// decides yes/no.
async function shouldRunSpec2Tests(_ctx: RunContext): Promise<boolean> {
  const mode = (process.env.MILL_SPEC2TESTS ?? "auto").trim().toLowerCase();
  if (mode === "off" || mode === "false" || mode === "0") return false;
  return true;
}

// Re-run entrypoint for the clarify stage: exposed separately so the CLI
// can call it inline before detaching.
export { clarify } from "./stages/clarify.js";
export { recordAnswers } from "./stages/clarify.js";
export { intake } from "./stages/intake.js";
