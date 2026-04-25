// spec2tests stage. Between design and implement. Translates the spec's
// acceptance criteria into failing tests and commits them so the
// implement stage has a red test suite to turn green.
//
// Edit mode: we already have a test runner from the project profile —
// the stage reads it, writes tests that run against it, and leaves the
// profile untouched.
//
// New mode: no profile, no runner. The stage picks a test framework
// that matches the spec's tech choices, bootstraps the minimum config
// needed to run it (package.json + devDep / pyproject.toml / Cargo.toml
// / Package.swift / etc.), writes failing tests, and records the
// resulting test command on the run row so the tests critic can
// execute it every review iteration.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { RunContext, StageResult } from "../../core/index.js";
import { readProfile, readProfileSummary } from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { pickStructured, runClaude } from "../claude-cli.js";
import { gitCommitAll } from "../git.js";

const Spec2TestsOutput = z.object({
  // Test command the implementer / tests critic will run. Required —
  // a bootstrapped harness is the whole point of the stage in new mode.
  test_command: z.string().min(1),
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
    const systemPrompt = await loadPrompt("spec2tests");
    const specBody = await readFile(ctx.paths.spec, "utf8");
    const profile = await readProfile(ctx.root);
    const profileSummary = await readProfileSummary(ctx.root);
    const existingTestCmd = profile?.commands.test ?? null;

    // The prompt behaves differently in edit vs new mode. In edit the
    // test runner already exists and the model just adds tests; in new
    // the model has to set up the runner too. A single prompt handles
    // both because we tell it which context it's in.
    const scaffoldBlock = existingTestCmd
      ? [
          `## Existing test runner`,
          `The project already has a configured test command: \`${existingTestCmd}\``,
          `Use it. Do not re-configure the runner.`,
          ``,
        ].join("\n")
      : [
          `## Bootstrap the test runner (new project)`,
          `No test runner is configured yet. Your job includes choosing one that matches the spec's tech choices and setting up the minimum scaffolding to run it:`,
          `- Node/TypeScript → Vitest (preferred for speed) or Jest. Initialize package.json, add a devDependency, and a \`test\` script.`,
          `- Python → pytest. Create a pyproject.toml or tox.ini as appropriate.`,
          `- Rust → \`cargo test\` (works out of the box once Cargo.toml exists).`,
          `- Swift → \`swift test\` (works out of the box once Package.swift with a test target exists).`,
          `- Go → \`go test ./...\``,
          `- Other stacks: pick the idiomatic choice for the ecosystem.`,
          `Keep the setup minimal — one devDep and a single test script, not a full CI pipeline. The implementer builds on top of what you set down.`,
          ``,
        ].join("\n");

    const profileBlock = profileSummary
      ? [`## Repo profile`, profileSummary, ``].join("\n")
      : "";

    const prompt = [
      profileBlock,
      scaffoldBlock,
      `## Spec`,
      specBody.trim(),
      ``,
      `Workdir: ${ctx.paths.workdir}`,
      ``,
      `Write failing tests for the acceptance criteria. Then run your test command once to prove the runner loads (tests should FAIL, not error out). Return the structured summary including the test command so the implementer and tests critic can run it later.`,
    ]
      .filter((s) => s.trim())
      .join("\n");

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
      // Scaffolding a test runner is heavier than just writing tests;
      // give the model more room than before.
      maxTurns: 40,
    });

    const parsed = Spec2TestsOutput.parse(pickStructured(res));

    // Commit whatever tests + scaffolding landed on disk. If the model
    // wrote nothing, this is a no-op and gitCommitAll returns null.
    const commitMsg = [
      `test: bootstrap test suite from spec`,
      ``,
      `${parsed.tests_added.length} test file(s) added covering ${parsed.tests_added.reduce((n, t) => n + t.criteria.length, 0)} criterion mapping(s).`,
      `Test command: ${parsed.test_command}`,
      parsed.skipped_criteria.length
        ? `${parsed.skipped_criteria.length} criterion skipped.`
        : "",
    ]
      .filter((s) => s !== "")
      .join("\n");
    const sha = await gitCommitAll(ctx.paths.workdir, commitMsg);

    // cost, usage, and session are persisted incrementally by runClaude.
    // We also persist the resolved test command on the run row here so
    // the tests critic and any future stage can find it.
    ctx.store.transaction(() => {
      ctx.store.updateRun(ctx.runId, { test_command: parsed.test_command });
      ctx.store.finishStage(ctx.runId, "spec2tests", {
        status: "completed",
        artifact_path: ctx.paths.workdir,
      });
    });

    return {
      ok: true,
      cost: res.costUsd,
      data: {
        testCommand: parsed.test_command,
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
