import type { Finding, RunContext, StageName, StageResult } from "../core/index.js";
import {
  BudgetExceededError,
  KilledError,
  killedSentinelExists,
  readProfile,
} from "../core/index.js";
import { buildContext } from "./context.js";
import { loadConfig, type DfConfig } from "./config.js";
import { clarify } from "./stages/clarify.js";
import { spec } from "./stages/spec.js";
import { design } from "./stages/design.js";
import { spec2tests } from "./stages/spec2tests.js";
import { implement } from "./stages/implement.js";
import { review, shouldStopReviewLoop } from "./stages/review.js";
import { verify } from "./stages/verify.js";
import { deliver } from "./stages/deliver.js";
import { decisions } from "./stages/decisions.js";

export interface RunPipelineArgs {
  runId: string;
  config?: DfConfig;
  ctx?: RunContext;
  // If set, return after the named stage completes successfully.
  // Used by `df new --stop-after <stage>` to halt early so the user
  // can review before paying for the rest. Resume via `df run <id>`
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
    const costUsd = ctx.budget.runTotal();
    const durationMs = Date.now() - startedAt;
    ctx.logger.info("pipeline stopped after stage (plan mode)", { stage });
    return {
      runId: ctx.runId,
      status: "planned",
      reason: `stopped after ${stage} (plan mode — resume with \`df run ${ctx.runId}\`)`,
      costUsd,
      durationMs,
    };
  };

  try {
    // 1. spec
    if (needsStage(ctx, "spec")) {
      const r = await spec(ctx);
      throwIfKilledOrBroken(ctx, r, "spec");
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
      throwIfKilledOrBroken(ctx, r, "design");
    }
    {
      const planned = plannedStop("design");
      if (planned) return planned;
    }

    // 3. spec2tests (optional; gated on profile + DF_SPEC2TESTS)
    if (needsStage(ctx, "spec2tests")) {
      if (await shouldRunSpec2Tests(ctx)) {
        const r = await spec2tests(ctx);
        throwIfKilledOrBroken(ctx, r, "spec2tests");
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
    let iteration = 0;
    let previousHigh: Finding[] = [];
    let currentHigh: Finding[] = [];
    let allHigh: Finding[] = [];
    let stopReason = "";

    while (iteration < config.maxReviewIters) {
      iteration += 1;
      ctx.logger.info("implement iteration", { iteration });

      const implResult = await implement({
        ctx,
        iteration,
        priorFindings: previousHigh,
      });
      throwIfKilledOrBroken(ctx, implResult, `implement-${iteration}`);

      const revResult = await review({ ctx, iteration });
      throwIfKilledOrBroken(ctx, revResult, `review-${iteration}`);
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

    // 4. verify
    const verifyResult = await verify(ctx);
    if (killedSentinelExists(ctx.paths.killed)) throw new KilledError(ctx.runId);

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
    const costUsd = finalRun?.total_cost_usd ?? ctx.budget.runTotal();
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
    const costUsd = ctx.budget.runTotal();
    if (err instanceof KilledError) {
      ctx.store.updateRun(ctx.runId, { status: "killed" });
      ctx.logger.warn("pipeline killed", { reason: err.message });
      return {
        runId: ctx.runId,
        status: "killed",
        reason: err.message,
        costUsd,
        durationMs,
      };
    }
    if (err instanceof BudgetExceededError) {
      ctx.store.updateRun(ctx.runId, { status: "failed" });
      ctx.logger.error("budget exceeded", {
        scope: err.scope,
        limit: err.limit,
        used: err.used,
      });
      return {
        runId: ctx.runId,
        status: "failed",
        reason: err.message,
        costUsd,
        durationMs,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.store.updateRun(ctx.runId, { status: "failed" });
    ctx.logger.error("pipeline failed", { err: msg });
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

function throwIfKilledOrBroken(
  ctx: RunContext,
  r: StageResult,
  label: string,
): void {
  if (killedSentinelExists(ctx.paths.killed)) {
    throw new KilledError(ctx.runId);
  }
  if (!r.ok) {
    throw new Error(`${label} failed: ${r.error ?? "unknown"}`);
  }
}

function needsStage(ctx: RunContext, name: Parameters<typeof ctx.store.getStage>[1]): boolean {
  const row = ctx.store.getStage(ctx.runId, name);
  // `skipped` counts as terminal — no rerun on resume. Only `completed`
  // and `skipped` short-circuit.
  if (!row) return true;
  return row.status !== "completed" && row.status !== "skipped";
}

// Gate spec2tests: requires a profile with a test command, and
// DF_SPEC2TESTS not set to "off". Default is auto (enable when
// available). Explicit "on" forces an error if unavailable.
async function shouldRunSpec2Tests(ctx: RunContext): Promise<boolean> {
  const mode = (process.env.DF_SPEC2TESTS ?? "auto").trim().toLowerCase();
  if (mode === "off" || mode === "false" || mode === "0") return false;
  const profile = await readProfile(ctx.root);
  const hasTestCmd = Boolean(profile?.commands.test);
  if (!hasTestCmd) {
    if (mode === "on" || mode === "true" || mode === "1") {
      throw new Error(
        "DF_SPEC2TESTS=on but no profile test command — run `df onboard` first",
      );
    }
    return false;
  }
  return true;
}

// Re-run entrypoint for the clarify stage: exposed separately so the CLI
// can call it inline before detaching.
export { clarify } from "./stages/clarify.js";
export { recordAnswers } from "./stages/clarify.js";
export { intake } from "./stages/intake.js";
