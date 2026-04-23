import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Clarifications, RunContext, StageResult } from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { pickStructured, runClaude } from "../claude-cli.js";

const ClarifyOutput = z.object({
  kind: z.enum(["ui", "backend", "cli"]),
  questions: z
    .array(
      z.object({
        id: z.string(),
        question: z.string(),
        why: z.string(),
        default: z.string().optional(),
      }),
    )
    .max(10),
});
const ClarifySchema = zodToJsonSchema(ClarifyOutput);

export async function clarify(ctx: RunContext): Promise<StageResult> {
  ctx.store.startStage(ctx.runId, "clarify");
  try {
    const systemPrompt = await loadPrompt("clarify");
    const requirement = await readFile(ctx.paths.requirement, "utf8");

    const res = await runClaude({
      ctx,
      stage: "clarify",
      prompt: `Requirement:\n\n${requirement}`,
      systemPrompt,
      jsonSchema: ClarifySchema,
      // --json-schema consumes an extra turn for the synthetic
      // StructuredOutput tool use, so leave some headroom.
      maxTurns: 6,
      permissionMode: "default",
      allowedTools: [],
    });

    // --json-schema delivers the parsed payload on res.structuredOutput; the
    // fallback in pickStructured handles older claude versions.
    const parsed = ClarifyOutput.parse(pickStructured(res));
    const clarifications: Clarifications = {
      kind: parsed.kind,
      questions: parsed.questions,
    };
    await writeFile(
      ctx.paths.clarifications,
      JSON.stringify(clarifications, null, 2),
      "utf8",
    );

    ctx.store.transaction(() => {
      ctx.store.addRunCost(ctx.runId, res.costUsd);
      if (res.sessionId) {
        ctx.store.saveSession(ctx.runId, "clarify", res.sessionId, res.costUsd);
      }
      ctx.store.saveClarifications(ctx.runId, clarifications);
      ctx.store.updateRun(ctx.runId, { kind: parsed.kind });
      ctx.store.finishStage(ctx.runId, "clarify", {
        status: "completed",
        cost_usd: res.costUsd,
        session_id: res.sessionId,
        artifact_path: ctx.paths.clarifications,
      });
    });
    return { ok: true, cost: res.costUsd, data: clarifications };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.store.finishStage(ctx.runId, "clarify", {
      status: "failed",
      error: msg,
    });
    return { ok: false, error: msg };
  }
}

// Record the user's answers into the store + filesystem. Called from the CLI
// once the user has responded to the inline prompt.
export async function recordAnswers(
  ctx: RunContext,
  answers: Record<string, string>,
): Promise<void> {
  const existing = ctx.store.getClarifications(ctx.runId);
  if (!existing) throw new Error(`no clarifications stored for ${ctx.runId}`);
  const next: Clarifications = { ...existing, answers };
  ctx.store.saveClarifications(ctx.runId, next);
  await writeFile(ctx.paths.clarifications, JSON.stringify(next, null, 2), "utf8");
  ctx.store.updateRun(ctx.runId, { status: "running" });
}
