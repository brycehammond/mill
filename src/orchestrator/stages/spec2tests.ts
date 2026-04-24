// spec2tests stage. Between design and implement. Generates tests
// from the spec's acceptance criteria, commits them on the run
// branch. Implement then makes them pass. The tests critic (review
// stage) runs the repo's test command on every iteration and gates
// the review loop on real pass/fail — so tests written here are the
// literal success signal for the whole run.
//
// Only meaningful when a profile with a test command exists, which
// means edit mode in practice. The pipeline caller decides whether
// to invoke this stage; when it does, the stage itself still handles
// the no-profile case defensively.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  RunContext,
  StageResult,
} from "../../core/index.js";
import {
  readProfile,
  readProfileSummary,
  usageStagePatch,
} from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { pickStructured, runClaude } from "../claude-cli.js";
import { gitCommitAll } from "../git.js";

const Spec2TestsOutput = z.object({
  tests_added: z.array(
    z.object({
      path: z.string(),
      criteria: z.array(z.number()),
      names: z.array(z.string()),
    }),
  ),
  skipped_criteria: z.array(
    z.object({
      criterion: z.number(),
      reason: z.string(),
    }),
  ),
  test_command_ran: z.boolean(),
  test_command_exit: z.number().nullable().optional(),
  summary: z.string(),
});
const Spec2TestsJsonSchema = zodToJsonSchema(Spec2TestsOutput);

export async function spec2tests(ctx: RunContext): Promise<StageResult> {
  ctx.store.startStage(ctx.runId, "spec2tests");
  try {
    const profile = await readProfile(ctx.root);
    if (!profile || !profile.commands.test) {
      // Defensive skip — the pipeline caller should also have gated
      // this out, but if we're invoked without a profile it's a pass
      // rather than a fail.
      ctx.store.finishStage(ctx.runId, "spec2tests", {
        status: "skipped",
        artifact_path: null,
      });
      return {
        ok: true,
        cost: 0,
        data: { skipped: true, reason: "no profile or no test command" },
      };
    }

    const systemPrompt = await loadPrompt("spec2tests");
    const specBody = await readFile(ctx.paths.spec, "utf8");
    const profileSummary = await readProfileSummary(ctx.root);

    const prompt = [
      `## Repo profile`,
      profileSummary || "(no profile summary)",
      ``,
      `## Spec`,
      specBody.trim(),
      ``,
      `Test command (will be run after your changes): \`${profile.commands.test}\``,
      ``,
      `Workdir: ${ctx.paths.workdir}`,
      ``,
      `Generate failing tests for the acceptance criteria. Return the structured summary.`,
    ].join("\n");

    const res = await runClaude({
      ctx,
      stage: "spec2tests",
      prompt,
      systemPrompt,
      cwd: ctx.paths.workdir,
      permissionMode: "bypassPermissions",
      settingSources: ["project"],
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      jsonSchema: Spec2TestsJsonSchema,
      // Writing tests is modest compared to implement — 20 turns is
      // plenty for read-existing + write-several + run-command.
      maxTurns: 20,
    });

    const parsed = Spec2TestsOutput.parse(pickStructured(res));

    // Commit whatever tests landed on disk. If the model wrote
    // nothing, this is a no-op and gitCommitAll returns null.
    const commitMsg = [
      `test: generate tests from spec`,
      ``,
      `${parsed.tests_added.length} test file(s) added covering ${parsed.tests_added.reduce((n, t) => n + t.criteria.length, 0)} criterion mapping(s).`,
      parsed.skipped_criteria.length
        ? `${parsed.skipped_criteria.length} criterion skipped.`
        : "",
    ]
      .filter((s) => s !== "")
      .join("\n");
    const sha = await gitCommitAll(ctx.paths.workdir, commitMsg);

    ctx.store.transaction(() => {
      ctx.store.addRunCost(ctx.runId, res.costUsd);
      ctx.store.addRunUsage(ctx.runId, res.usage);
      if (res.sessionId) {
        ctx.store.saveSession(ctx.runId, "spec2tests", res.sessionId, res.costUsd);
      }
      ctx.store.finishStage(ctx.runId, "spec2tests", {
        status: "completed",
        cost_usd: res.costUsd,
        ...usageStagePatch(res.usage),
        session_id: res.sessionId,
        artifact_path: ctx.paths.workdir,
      });
    });

    return {
      ok: true,
      cost: res.costUsd,
      data: {
        testsAdded: parsed.tests_added,
        skippedCriteria: parsed.skipped_criteria,
        testCommandExit: parsed.test_command_exit ?? null,
        sha,
        summary: parsed.summary,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.store.finishStage(ctx.runId, "spec2tests", {
      status: "failed",
      error: msg,
    });
    return { ok: false, error: msg };
  }
}
