import { readFile, writeFile } from "node:fs/promises";
import type { RunContext, StageResult } from "../../core/index.js";
import {
  readJournalTail,
  readProfileSummary,
  renderLedgerHint,
} from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { extractMarkdownBlock, runClaude } from "../claude-cli.js";

export async function designArchitecture(
  ctx: RunContext,
): Promise<StageResult> {
  const promptName = ctx.mode === "edit" ? "design-arch-edit" : "design-arch";
  const systemPrompt = await loadPrompt(promptName);
  const specBody = await readFile(ctx.paths.spec, "utf8");
  const journal = await readJournalTail(ctx.root, 20);
  const profile = await readProfileSummary(ctx.root);
  const profileBlock = profile ? `## Repo profile\n\n${profile}\n` : "";
  const ledgerBlock =
    ctx.mode === "edit" ? renderLedgerHint(ctx.store, { limit: 5 }) : "";

  const workdirBlock =
    ctx.mode === "edit"
      ? [
          `## Existing codebase`,
          `Workdir: ${ctx.paths.workdir}`,
          `Read relevant files with Read/Glob/Grep before writing architecture.md.`,
          ``,
        ].join("\n")
      : "";

  const prompt = [profileBlock, ledgerBlock, journal, workdirBlock, `## Spec`, specBody]
    .filter((s) => s !== "")
    .join("\n");

  const res = await runClaude({
    ctx,
    stage: "design",
    prompt,
    systemPrompt,
    maxTurns: ctx.mode === "edit" ? 12 : 4,
    permissionMode: "default",
    allowedTools: ctx.mode === "edit" ? ["Read", "Glob", "Grep"] : [],
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
