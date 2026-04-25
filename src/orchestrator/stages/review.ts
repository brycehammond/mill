import { readFile } from "node:fs/promises";
import type {
  CriticName,
  Finding,
  RunContext,
  StageResult,
} from "../../core/index.js";
import {
  atLeast,
  findingFingerprint,
  resolveTestCommand,
} from "../../core/index.js";
import { correctnessCritic } from "../critics/correctness.js";
import { securityCritic } from "../critics/security.js";
import { uxCritic } from "../critics/ux.js";
import {
  adversarialCritic,
  canRunAdversarial,
  isCodexCliAvailable,
} from "../critics/adversarial.js";
import { testsCritic } from "../critics/tests.js";
import type { CriticResult } from "../critics/shared.js";
import { runTeamReview, type TeamReviewOutput } from "../critics/team-review.js";

export interface ReviewArgs {
  ctx: RunContext;
  iteration: number;
}

export interface ReviewOutput {
  findings: Finding[];
  highFindings: Finding[];
  summaries: { critic: string; summary: string }[];
  cost: number;
  reportPaths: string[];
}

// Run the critics in parallel, aggregate their findings, write a
// per-iteration index. The first three (security/correctness/ux) always
// run; a fourth "adversarial" critic backed by `/codex:adversarial-review`
// joins the pool when MILL_ADVERSARIAL_REVIEW allows and the Codex plugin
// is configured. Returns the HIGH/CRITICAL list that feeds the next
// implement iteration.
export async function review(args: ReviewArgs): Promise<StageResult & { data: ReviewOutput }> {
  const { ctx, iteration } = args;
  ctx.store.startStage(ctx.runId, "review");
  try {
    const specBody = await readFile(ctx.paths.spec, "utf8");
    const designBody = ctx.kind === "ui"
      ? await readFile(ctx.paths.designIntent, "utf8").catch(() => "")
      : await readFile(ctx.paths.architecture, "utf8").catch(() => "");

    const shared = { ctx, iteration, specBody, designBody };

    // Decide up front whether the three LLM critics (security/correctness/ux)
    // run as a Claude Code agent team (one subprocess, cross-critic chatter)
    // or as independent subprocesses (today's behavior, one subprocess each).
    // tests + adversarial never go through the team — tests is mechanical,
    // adversarial is codex-backed.
    const teamsMode = resolveAgentTeamsMode();
    let teamOutcome: TeamOutcome | null = null;
    if (teamsMode !== "off") {
      try {
        const teamResult = await runTeamReview(shared);
        teamOutcome = { ok: true, output: teamResult };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (teamsMode === "on") {
          // Hard mode: surface the failure instead of quietly falling back.
          throw new Error(`MILL_AGENT_TEAMS=on but team review failed: ${msg}`);
        }
        ctx.logger.warn("team review failed — falling back to per-critic subprocesses", {
          err: msg,
        });
        teamOutcome = { ok: false };
      }
    }

    const critics: Promise<CriticResult>[] = [];
    const names: CriticName[] = [];
    if (!teamOutcome?.ok) {
      critics.push(securityCritic(shared), correctnessCritic(shared), uxCritic(shared));
      names.push("security", "correctness", "ux");
    }

    // The tests critic runs the run's test command and turns failures
    // into HIGH findings. Activates whenever a test command is
    // resolvable — either spec2tests wrote it to the run row, or an
    // edit-mode profile has one. Opt-out with MILL_TESTS_CRITIC=off.
    const testsMode = resolveTestsMode();
    if (testsMode !== "off") {
      const run = ctx.store.getRun(ctx.runId);
      const testCmd = await resolveTestCommand({
        root: ctx.root,
        runTestCommand: run?.test_command ?? null,
      });
      if (testCmd) {
        critics.push(testsCritic(shared));
        names.push("tests");
      } else if (testsMode === "on") {
        throw new Error(
          "MILL_TESTS_CRITIC=on but no test command resolved — spec2tests didn't run, and no project profile has one. Run `mill onboard` first or set MILL_SPEC2TESTS=on.",
        );
      }
    }

    const adversarialMode = resolveAdversarialMode();
    if (adversarialMode !== "off") {
      const availability = canRunAdversarial();
      const codexReady = availability.ok
        ? await isCodexCliAvailable()
        : false;
      if (availability.ok && codexReady) {
        critics.push(
          adversarialCritic({ ...shared, companionPath: availability.companionPath! }),
        );
        names.push("adversarial");
      } else if (adversarialMode === "on") {
        const reason = !availability.ok
          ? availability.reason
          : "codex CLI not found on PATH";
        throw new Error(
          `MILL_ADVERSARIAL_REVIEW=on but adversarial critic unavailable: ${reason}`,
        );
      } else {
        ctx.logger.debug("adversarial critic skipped", {
          plugin: availability.ok,
          codex: codexReady,
        });
      }
    }

    const settled = await Promise.allSettled(critics);

    const findings: Finding[] = [];
    const summaries: { critic: string; summary: string }[] = [];
    const reportPaths: string[] = [];
    let cost = 0;
    let anyFailed = false;

    // Fold team-mode output in first so per-critic order in the summary
    // stays consistent (security → correctness → ux → tests → adversarial).
    if (teamOutcome?.ok) {
      findings.push(...teamOutcome.output.findings);
      summaries.push(...teamOutcome.output.summaries);
      reportPaths.push(...teamOutcome.output.reportPaths);
      cost += teamOutcome.output.cost;
      if (teamOutcome.output.anyFailed) anyFailed = true;
    }

    let succeededCount = 0;
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        findings.push(...r.value.findings);
        summaries.push({ critic: names[i]!, summary: r.value.summary });
        reportPaths.push(r.value.reportPath);
        cost += r.value.cost;
        succeededCount += 1;
      } else {
        anyFailed = true;
        ctx.logger.error("critic failed", {
          critic: names[i],
          err: String(r.reason),
        });
        summaries.push({
          critic: names[i]!,
          summary: `ERROR: ${String(r.reason).slice(0, 200)}`,
        });
      }
    });
    if (teamOutcome?.ok) succeededCount += 1;

    const highFindings = findings.filter((f) => atLeast(f.severity, "HIGH"));

    // Per-critic cost/usage/findings are already committed (cost/usage via
    // runClaude's incremental persistence, findings via runCritic's
    // transaction). This just finalizes the stage row.
    //
    // Tolerance: review is "completed" as long as at least one critic
    // produced findings. A single critic blowing its turn cap shouldn't
    // tank the run — the other critics' findings still feed the next
    // implement iteration. We surface the partial failure in the stage
    // row's error column for visibility without throwing.
    const partial = anyFailed && succeededCount > 0;
    const allFailed = anyFailed && succeededCount === 0;
    const errorMsg = allFailed
      ? "all critics failed"
      : partial
        ? `partial failure (${succeededCount} ok); see review reports`
        : null;
    ctx.store.finishStage(ctx.runId, "review", {
      status: allFailed ? "failed" : "completed",
      artifact_path: ctx.paths.reviewsDir,
      error: errorMsg,
    });

    const data: ReviewOutput = {
      findings,
      highFindings,
      summaries,
      cost,
      reportPaths,
    };
    return { ok: !allFailed, cost, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.store.finishStage(ctx.runId, "review", {
      status: "failed",
      error: msg,
    });
    return {
      ok: false,
      error: msg,
      data: {
        findings: [],
        highFindings: [],
        summaries: [],
        cost: 0,
        reportPaths: [],
      },
    };
  }
}

// Termination rule: stop the implement⇄review loop when any of:
//  1. max iterations reached
//  2. no HIGH+ findings this iteration
//  3. HIGH findings this iteration are a subset of last iteration's (stuck)
export function shouldStopReviewLoop(args: {
  iteration: number;
  maxIters: number;
  currentHigh: Finding[];
  previousHigh: Finding[];
}): { stop: boolean; reason: string } {
  if (args.iteration >= args.maxIters) {
    return { stop: true, reason: `max iterations (${args.maxIters}) reached` };
  }
  if (args.currentHigh.length === 0) {
    return { stop: true, reason: "no HIGH+ findings" };
  }
  const prevSet = new Set(args.previousHigh.map(findingFingerprint));
  const curSet = new Set(args.currentHigh.map(findingFingerprint));
  if (prevSet.size > 0) {
    let allSubset = true;
    for (const f of curSet) {
      if (!prevSet.has(f)) {
        allSubset = false;
        break;
      }
    }
    if (allSubset) {
      return { stop: true, reason: "stuck: findings are a subset of prior" };
    }
  }
  return { stop: false, reason: "" };
}

type TeamOutcome =
  | { ok: true; output: TeamReviewOutput }
  | { ok: false };

type AgentTeamsMode = "auto" | "on" | "off";

function resolveAgentTeamsMode(): AgentTeamsMode {
  const raw = (process.env.MILL_AGENT_TEAMS ?? "auto").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return "on";
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  return "auto";
}

type AdversarialMode = "auto" | "on" | "off";

function resolveAdversarialMode(): AdversarialMode {
  const raw = (process.env.MILL_ADVERSARIAL_REVIEW ?? "auto").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return "on";
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  return "auto";
}

type TestsMode = "auto" | "on" | "off";

function resolveTestsMode(): TestsMode {
  const raw = (process.env.MILL_TESTS_CRITIC ?? "auto").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return "on";
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  return "auto";
}
