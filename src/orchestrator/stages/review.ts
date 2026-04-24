import { readFile } from "node:fs/promises";
import type {
  CriticName,
  Finding,
  RunContext,
  StageResult,
  TokenUsage,
} from "../../core/index.js";
import {
  atLeast,
  readProfile,
  usageStagePatch,
  ZERO_USAGE,
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
// joins the pool when DF_ADVERSARIAL_REVIEW allows and the Codex plugin
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
    const critics: Promise<CriticResult>[] = [
      securityCritic(shared),
      correctnessCritic(shared),
      uxCritic(shared),
    ];
    const names: CriticName[] = ["security", "correctness", "ux"];

    // The tests critic runs the repo's real test command (from the
    // profile) and turns failures into HIGH findings. Only activates
    // when a profile exists AND has a test command set. Opt-out with
    // DF_TESTS_CRITIC=off. Typically only meaningful in edit mode —
    // new-mode scaffolds don't have an external profile, though they
    // could if the user ran `df onboard` on the enclosing project
    // before `df new`.
    const testsMode = resolveTestsMode();
    if (testsMode !== "off") {
      const profile = await readProfile(ctx.root);
      if (profile?.commands.test) {
        critics.push(testsCritic(shared));
        names.push("tests");
      } else if (testsMode === "on") {
        throw new Error(
          "DF_TESTS_CRITIC=on but no test command in .df/profile.json — run `df onboard` first",
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
          `DF_ADVERSARIAL_REVIEW=on but adversarial critic unavailable: ${reason}`,
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
    let usage: TokenUsage = { ...ZERO_USAGE };
    let anyFailed = false;

    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        findings.push(...r.value.findings);
        summaries.push({ critic: names[i]!, summary: r.value.summary });
        reportPaths.push(r.value.reportPath);
        cost += r.value.cost;
        usage = sumUsage(usage, r.value.usage);
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

    const highFindings = findings.filter((f) => atLeast(f.severity, "HIGH"));

    // Per-critic cost + findings are already committed inside runCritic()'s
    // transaction. This transaction only finalizes the stage row itself —
    // tokens here are the sum across all critics for the iteration, mirroring
    // cost_usd.
    ctx.store.transaction(() => {
      ctx.store.finishStage(ctx.runId, "review", {
        status: anyFailed ? "failed" : "completed",
        cost_usd: cost,
        ...usageStagePatch(usage),
        artifact_path: ctx.paths.reviewsDir,
        error: anyFailed ? "one or more critics failed" : null,
      });
    });

    const data: ReviewOutput = {
      findings,
      highFindings,
      summaries,
      cost,
      reportPaths,
    };
    return { ok: !anyFailed, cost, data };
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
//  4. budget exceeded (caller handles this via BudgetExceededError)
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
  const prevSet = new Set(args.previousHigh.map(fingerprint));
  const curSet = new Set(args.currentHigh.map(fingerprint));
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

function fingerprint(f: Finding): string {
  return `${f.critic}|${f.severity}|${f.title.trim().toLowerCase()}`;
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cache_creation: a.cache_creation + b.cache_creation,
    cache_read: a.cache_read + b.cache_read,
    output: a.output + b.output,
  };
}

type AdversarialMode = "auto" | "on" | "off";

function resolveAdversarialMode(): AdversarialMode {
  const raw = (process.env.DF_ADVERSARIAL_REVIEW ?? "auto").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return "on";
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  return "auto";
}

type TestsMode = "auto" | "on" | "off";

function resolveTestsMode(): TestsMode {
  const raw = (process.env.DF_TESTS_CRITIC ?? "auto").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return "on";
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  return "auto";
}
