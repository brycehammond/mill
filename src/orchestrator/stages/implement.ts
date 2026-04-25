import { readFile } from "node:fs/promises";
import type { RunContext, StageResult, Finding } from "../../core/index.js";
import {
  SEVERITY_ORDER,
  readProfileSummary,
  renderLedgerHint,
  resolveTestCommand,
} from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { runClaude } from "../claude-cli.js";
import { gitCommitAll, gitCommitEmpty, gitInit, gitTag, gitHead } from "../git.js";
import { pathExists } from "../../core/index.js";

export interface ImplementArgs {
  ctx: RunContext;
  iteration: number; // 1-based
  priorFindings: Finding[]; // HIGH/CRITICAL findings from the previous review
}

export async function implement(args: ImplementArgs): Promise<StageResult> {
  const { ctx, iteration, priorFindings } = args;
  ctx.store.startStage(ctx.runId, "implement");
  try {
    // In edit mode the worktree was materialized at intake — `.git`
    // exists as a *file* (gitdir pointer), not a directory; `pathExists`
    // via fs.stat resolves both, so `firstRun` is correctly false. The
    // impl/iter-0 tag was placed at intake on the base HEAD.
    const firstRun = !(await pathExists(`${ctx.paths.workdir}/.git`));
    if (firstRun && ctx.mode === "new") {
      await gitInit(ctx.paths.workdir);
      // Empty initial commit anchors impl/iter-0 so the adversarial
      // critic always has a stable base ref to diff against, even on
      // iteration 1 when the other tags don't exist yet.
      await gitCommitEmpty(ctx.paths.workdir, "chore: initial empty workdir");
      await gitTag(ctx.paths.workdir, "impl/iter-0");
    } else if (firstRun) {
      throw new Error(
        `implement: edit-mode run has no .git at workdir ${ctx.paths.workdir} — intake worktree creation must have failed`,
      );
    }

    const systemPrompt = await loadPrompt("implement");
    const specBody = await readFile(ctx.paths.spec, "utf8");
    const designBody = ctx.kind === "ui"
      ? await readFile(ctx.paths.designIntent, "utf8").catch(() => "")
      : await readFile(ctx.paths.architecture, "utf8").catch(() => "");

    const prior = ctx.store.getSession(ctx.runId, "implement");
    const resume = iteration > 1 && prior ? prior.sessionId : undefined;

    // Profile is only injected on the first iteration — the resumed
    // session already has it in history. Cheap either way, since
    // cache-read dominates.
    const profile = iteration === 1 ? await readProfileSummary(ctx.root) : "";
    const ledger =
      iteration === 1 && ctx.mode === "edit"
        ? renderLedgerHint(ctx.store, { limit: 5 })
        : "";

    const timeoutMs = ctx.stageTimeoutsMs.implement ?? ctx.stageTimeoutMs;
    const timeBudgetMin = Math.round(timeoutMs / 60_000);
    const run = ctx.store.getRun(ctx.runId);
    const testCommand = await resolveTestCommand({
      root: ctx.root,
      runTestCommand: run?.test_command ?? null,
    });
    const prompt = buildPrompt({
      iteration,
      specBody,
      designBody,
      priorFindings,
      resume,
      profile,
      ledger,
      timeBudgetMin,
      testCommand,
    });

    const res = await runClaude({
      ctx,
      stage: "implement",
      prompt,
      systemPrompt,
      cwd: ctx.paths.workdir,
      permissionMode: "bypassPermissions",
      // Per-run sandbox (path + kill) lives in runs/<id>/.claude/settings.json
      // which is picked up via settingSources: ['project']. UI builds also
      // inherit user-global MCPs (Stitch).
      settingSources: ctx.kind === "ui" ? ["user", "project"] : ["project"],
      allowedTools: [
        "Read",
        "Edit",
        "Write",
        "Bash",
        "Glob",
        "Grep",
        "NotebookEdit",
        "TodoWrite",
        "mcp__stitch__get_screen",
        "mcp__stitch__list_screens",
      ],
      resume,
      maxTurns: 60,
    });

    const msg = `impl: iter ${iteration}\n\n${truncate(res.text, 400)}`;
    const sha = await gitCommitAll(ctx.paths.workdir, msg);
    if (sha) {
      await gitTag(ctx.paths.workdir, `impl/iter-${iteration}`);
    } else {
      // implementer may have already committed; tag HEAD anyway
      const head = await gitHead(ctx.paths.workdir);
      if (head) await gitTag(ctx.paths.workdir, `impl/iter-${iteration}`);
    }

    // cost, usage, and session are persisted incrementally by runClaude as
    // result events stream in, so a SIGTERM mid-stage still leaves the row
    // accurate. finishStage only sets terminal fields here.
    ctx.store.finishStage(ctx.runId, "implement", {
      status: "completed",
      artifact_path: ctx.paths.workdir,
    });
    return {
      ok: true,
      cost: res.costUsd,
      data: { iteration, sessionId: res.sessionId, sha },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.store.finishStage(ctx.runId, "implement", {
      status: "failed",
      error: message,
    });
    return { ok: false, error: message };
  }
}

function buildPrompt(args: {
  iteration: number;
  specBody: string;
  designBody: string;
  priorFindings: Finding[];
  resume: string | undefined;
  profile: string;
  ledger: string;
  timeBudgetMin: number;
  testCommand: string | null;
}): string {
  // Stages get a hard wall-clock timeout. Surfacing it in the prompt lets
  // the model pace itself: commit logical chunks as it goes (so SIGTERM
  // doesn't cost the whole attempt), and prioritize the spec's acceptance
  // criteria over nice-to-haves when the budget is tight.
  const budgetBlock = `# Time budget\nYou have ~${args.timeBudgetMin} minutes of wall-clock time for this stage before the subprocess is force-killed. Commit one AC at a time so a SIGTERM mid-flight only costs you the current AC, not the whole run.`;
  const testBlock = args.testCommand
    ? `# Test command\nRun \`${args.testCommand}\` to execute the test suite. Run it (a) at the start, to confirm red tests for each AC, (b) after each AC is implemented, to confirm green, and (c) before you finish, to confirm the full suite is green.`
    : `# Test command\nThe test command for this run was not set (spec2tests didn't run or didn't record one). Decide on a runner that matches the tech choices, wire it up early, and use it. Announce it in your final summary.`;
  if (args.iteration === 1 || !args.resume) {
    const profileBlock = args.profile
      ? [`# Repo profile`, args.profile.trim(), ``].join("\n")
      : "";
    const ledgerBlock = args.ledger ? args.ledger.trim() + "\n" : "";
    return [
      profileBlock,
      ledgerBlock,
      budgetBlock,
      ``,
      testBlock,
      ``,
      `# spec.md`,
      args.specBody.trim(),
      ``,
      `# design`,
      args.designBody.trim() || "(no design doc — treat spec as sufficient)",
      ``,
      `Begin implementation. Follow the red→green→refactor→commit cadence, one AC at a time.`,
    ]
      .filter((s) => s !== "")
      .join("\n");
  }
  const sorted = [...args.priorFindings].sort(
    (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity],
  );
  const findingsBlock = sorted
    .map(
      (f, i) =>
        `${i + 1}. **[${f.severity}] ${f.critic}: ${f.title}**\n   Evidence: ${f.evidence}\n   Suggested fix: ${f.suggested_fix}`,
    )
    .join("\n\n");
  return [
    budgetBlock,
    ``,
    testBlock,
    ``,
    `Review iteration ${args.iteration}. The prior review pass returned the following HIGH/CRITICAL findings that remain unresolved. Address each one, rebutting in a commit message if you disagree. When you change behavior, add or update a test first.`,
    ``,
    findingsBlock,
    ``,
    `Make the changes and commit.`,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}
