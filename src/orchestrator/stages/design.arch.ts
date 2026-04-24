import { readFile, writeFile } from "node:fs/promises";
import type { RunContext, StageResult } from "../../core/index.js";
import {
  readDecisionsTail,
  readJournalTail,
  readProfileSummary,
  renderLedgerHint,
} from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { extractMarkdownBlock, runClaude } from "../claude-cli.js";
import { runWithRetry } from "../retry.js";

export async function designArchitecture(
  ctx: RunContext,
): Promise<StageResult> {
  const promptName = ctx.mode === "edit" ? "design-arch-edit" : "design-arch";
  const systemPrompt = await loadPrompt(promptName);
  const specBody = await readFile(ctx.paths.spec, "utf8");
  const journal = await readJournalTail(ctx.root, 20);
  const decisionsBlock = await readDecisionsTail(ctx.root, 10);
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

  const prompt = [
    profileBlock,
    ledgerBlock,
    decisionsBlock,
    journal,
    workdirBlock,
    `## Spec`,
    specBody,
  ]
    .filter((s) => s !== "")
    .join("\n");

  const res = await runWithRetry({
    ctx,
    stage: "design",
    label: "output-too-short",
    attempt: (hint) =>
      runClaude({
        ctx,
        stage: "design",
        prompt: hint ? `${prompt}\n\n## Retry hint\n${hint}` : prompt,
        systemPrompt,
        maxTurns: ctx.mode === "edit" ? 12 : 4,
        permissionMode: "default",
        allowedTools: ctx.mode === "edit" ? ["Read", "Glob", "Grep"] : [],
      }),
    validate: (r) => {
      const md = extractMarkdownBlock(r.text);
      if (!md || md.length < 50) {
        return `Your previous response's markdown block was only ${md.length} characters — far too short to be a usable architecture doc. Emit a substantial architecture.md with sections for components, data flow, interfaces, and key decisions. Wrap the whole doc in a single fenced \`\`\`markdown block.`;
      }
      return null;
    },
  });

  const md = extractMarkdownBlock(res.text);
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
