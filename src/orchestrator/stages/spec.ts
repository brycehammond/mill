import { readFile, writeFile } from "node:fs/promises";
import type { RunContext, StageResult } from "../../core/index.js";
import { usageStagePatch } from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { extractMarkdownBlock, runClaude } from "../claude-cli.js";

export async function spec(ctx: RunContext): Promise<StageResult> {
  ctx.store.startStage(ctx.runId, "spec");
  try {
    const systemPrompt = await loadPrompt("spec");
    const requirement = await readFile(ctx.paths.requirement, "utf8");
    const clarifications = ctx.store.getClarifications(ctx.runId);
    if (!clarifications) {
      throw new Error("no clarifications available");
    }
    if (!clarifications.answers) {
      throw new Error("clarifications missing user answers");
    }

    const body = [
      `KIND: ${clarifications.kind}`,
      ``,
      `## Requirement`,
      requirement.trim(),
      ``,
      `## Clarifying questions + answers`,
      JSON.stringify(
        {
          questions: clarifications.questions,
          answers: clarifications.answers,
        },
        null,
        2,
      ),
    ].join("\n");

    const res = await runClaude({
      ctx,
      stage: "spec",
      prompt: body,
      systemPrompt,
      maxTurns: 4,
      permissionMode: "default",
      allowedTools: [],
    });

    const md = extractMarkdownBlock(res.text);
    if (!md || md.length < 50) {
      throw new Error("spec output too short");
    }
    await writeFile(ctx.paths.spec, md.trim() + "\n", "utf8");

    ctx.store.transaction(() => {
      ctx.store.addRunCost(ctx.runId, res.costUsd);
      ctx.store.addRunUsage(ctx.runId, res.usage);
      if (res.sessionId) {
        ctx.store.saveSession(ctx.runId, "spec", res.sessionId, res.costUsd);
      }
      ctx.store.updateRun(ctx.runId, { spec_path: ctx.paths.spec });
      ctx.store.finishStage(ctx.runId, "spec", {
        status: "completed",
        cost_usd: res.costUsd,
        ...usageStagePatch(res.usage),
        session_id: res.sessionId,
        artifact_path: ctx.paths.spec,
      });
    });
    return { ok: true, cost: res.costUsd };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.store.finishStage(ctx.runId, "spec", {
      status: "failed",
      error: msg,
    });
    return { ok: false, error: msg };
  }
}
