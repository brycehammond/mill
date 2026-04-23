import { readFile, writeFile } from "node:fs/promises";
import type { RunContext, StageResult } from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { extractMarkdownBlock, runClaude } from "../claude-cli.js";

export async function designArchitecture(
  ctx: RunContext,
): Promise<StageResult> {
  const systemPrompt = await loadPrompt("design-arch");
  const specBody = await readFile(ctx.paths.spec, "utf8");

  const res = await runClaude({
    ctx,
    stage: "design",
    prompt: `Spec:\n\n${specBody}`,
    systemPrompt,
    maxTurns: 4,
    permissionMode: "default",
    allowedTools: [],
  });

  const md = extractMarkdownBlock(res.text);
  if (!md || md.length < 50) {
    throw new Error("architecture output too short");
  }
  await writeFile(ctx.paths.architecture, md.trim() + "\n", "utf8");

  return {
    ok: true,
    cost: res.costUsd,
    data: {
      path: ctx.paths.architecture,
      sessionId: res.sessionId,
      usage: res.usage,
    },
  };
}
