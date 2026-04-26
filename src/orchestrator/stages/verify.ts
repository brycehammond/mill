import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { RunContext, StageResult } from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { pickStructured, runClaude } from "../claude-cli.js";
import { defaultSettingSources } from "../config.js";

const VerifyOutput = z.object({
  report_md: z.string().min(10),
  pass: z.boolean(),
  criteria: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      pass: z.boolean(),
      evidence_path: z.string().optional(),
    }),
  ),
  logs: z
    .object({
      test_stdout: z.string().optional(),
      test_stderr: z.string().optional(),
      server_log: z.string().optional(),
    })
    .optional(),
});
const VerifyJsonSchema = zodToJsonSchema(VerifyOutput);

export async function verify(ctx: RunContext): Promise<StageResult> {
  ctx.store.startStage(ctx.runId, "verify");
  try {
    const systemPrompt = await loadPrompt("verify");
    const specBody = await readFile(ctx.paths.spec, "utf8");

    const prompt = [
      `KIND: ${ctx.kind}`,
      `Workdir: ${ctx.paths.workdir}`,
      `Verify output dir: ${ctx.paths.verifyDir}`,
      ``,
      `## spec.md`,
      specBody.trim(),
    ].join("\n");

    const res = await runClaude({
      ctx,
      stage: "verify",
      prompt,
      systemPrompt,
      cwd: ctx.paths.workdir,
      permissionMode: "bypassPermissions",
      // verify writes into the verify dir outside the workdir; expose it
      // via --add-dir (Claude Code access control) and via extraWriteDirs
      // (our guard.ts sandbox).
      addDir: [ctx.paths.verifyDir],
      extraWriteDirs: [ctx.paths.verifyDir],
      allowedTools: ["Read", "Write", "Glob", "Grep", "Bash"],
      // Default user+project so Playwright/Stitch/etc. user MCPs (and any
      // user skills/hooks) are visible. MILL_USER_HOOKS=off reverts to
      // project-only isolation.
      settingSources: defaultSettingSources(),
      jsonSchema: VerifyJsonSchema,
      maxTurns: 40,
    });

    const parsed = VerifyOutput.parse(pickStructured(res));
    await writeFile(
      `${ctx.paths.verifyDir}/report.md`,
      parsed.report_md.trim() + "\n",
      "utf8",
    );

    // cost, usage, and session are persisted incrementally by runClaude.
    ctx.store.finishStage(ctx.runId, "verify", {
      status: parsed.pass ? "completed" : "failed",
      artifact_path: `${ctx.paths.verifyDir}/report.md`,
      error: parsed.pass ? null : "one or more criteria failed",
    });
    return {
      ok: parsed.pass,
      cost: res.costUsd,
      data: parsed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.store.finishStage(ctx.runId, "verify", {
      status: "failed",
      error: msg,
    });
    return { ok: false, error: msg };
  }
}
