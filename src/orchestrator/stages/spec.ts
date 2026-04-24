import { readFile, writeFile } from "node:fs/promises";
import type { RunContext, StageResult } from "../../core/index.js";
import {
  readJournalTail,
  readProfileSummary,
  renderLedgerHint,
  usageStagePatch,
} from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { extractMarkdownBlock, runClaude } from "../claude-cli.js";

export async function spec(ctx: RunContext): Promise<StageResult> {
  ctx.store.startStage(ctx.runId, "spec");
  try {
    const promptName = ctx.mode === "edit" ? "spec-edit" : "spec";
    const systemPrompt = await loadPrompt(promptName);
    const requirement = await readFile(ctx.paths.requirement, "utf8");
    const clarifications = ctx.store.getClarifications(ctx.runId);
    if (!clarifications) {
      throw new Error("no clarifications available");
    }
    if (!clarifications.answers) {
      throw new Error("clarifications missing user answers");
    }

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
            `Read relevant files with Read/Glob/Grep before writing the spec.`,
            ``,
          ].join("\n")
        : "";

    const body = [
      profileBlock,
      ledgerBlock,
      journal,
      workdirBlock,
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
    ]
      .filter((s) => s !== "")
      .join("\n");

    const res = await runClaude({
      ctx,
      stage: "spec",
      prompt: body,
      systemPrompt,
      // Edit mode: read codebase with Read/Glob/Grep before specifying.
      // runClaude defaults cwd to ctx.paths.workdir, which is the git
      // worktree checkout in edit mode.
      maxTurns: ctx.mode === "edit" ? 12 : 4,
      permissionMode: "default",
      allowedTools: ctx.mode === "edit" ? ["Read", "Glob", "Grep"] : [],
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
