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

    const journal = await readJournalTail(ctx.stateDir, 20);
    const decisionsBlock = await readDecisionsTail(ctx.stateDir, 10);
    const profile = await readProfileSummary(ctx.stateDir);
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
      decisionsBlock,
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

    const res = await runWithRetry({
      ctx,
      stage: "spec",
      label: "output-too-short",
      attempt: (hint) =>
        runClaude({
          ctx,
          stage: "spec",
          prompt: hint ? `${body}\n\n## Retry hint\n${hint}` : body,
          systemPrompt,
          // Edit mode: read codebase with Read/Glob/Grep before specifying.
          // runClaude defaults cwd to ctx.paths.workdir, which is the git
          // worktree checkout in edit mode. 30 turns matches the critic
          // budget — a real codebase needs many Read/Glob/Grep calls
          // before the model can write a meaningful spec, and 12 was
          // bottoming out as `error_max_turns` on populated repos
          // (silent failure: empty markdown block triggered the
          // output-too-short retry loop, doubling spend without ever
          // letting the model finish the spec).
          maxTurns: ctx.mode === "edit" ? 30 : 4,
          permissionMode: "default",
          allowedTools: ctx.mode === "edit" ? ["Read", "Glob", "Grep"] : [],
        }),
      validate: (r) => {
        const md = extractMarkdownBlock(r.text);
        if (!md || md.length < 50) {
          return `Your previous response's markdown block was only ${md.length} characters — far too short to be a usable spec. Emit a substantial spec document with sections for goals, non-goals, assumptions, user-facing behavior, acceptance criteria, and open questions. Wrap the whole spec in a single fenced \`\`\`markdown block.`;
        }
        return null;
      },
    });

    const md = extractMarkdownBlock(res.text);
    await writeFile(ctx.paths.spec, md.trim() + "\n", "utf8");

    // cost, usage, and session are persisted incrementally by runClaude.
    ctx.store.transaction(() => {
      ctx.store.updateRun(ctx.runId, { spec_path: ctx.paths.spec });
      ctx.store.finishStage(ctx.runId, "spec", {
        status: "completed",
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
