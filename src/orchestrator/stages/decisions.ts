// Post-deliver sub-stage: extract 0–3 ADR-lite entries from this run
// and append them to `.mill/decisions.md`. Future runs inject the tail
// into their spec + design prompts (see renderDecisionsHint), so
// non-obvious trade-offs already weighed on this repo aren't silently
// reversed by an implementer working from a blank spec.
//
// This stage is best-effort: a failure here does NOT fail the run.
// The run has already been delivered (shipped) by the time we run.
// We still persist a stage row so `mill status` shows we tried, and so
// the pipeline's crash-recovery path doesn't rerun us forever.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { FindingRow, RunContext, StageResult } from "../../core/index.js";
import {
  appendDecisionEntries,
  readDecisionsTail,
  type DecisionEntry,
} from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { pickStructured, runClaude } from "../claude-cli.js";

const execFileP = promisify(execFile);

const TriggerEnum = z.enum(["finding", "spec", "constraint"]);
const DecisionsOutputSchema = z.object({
  entries: z
    .array(
      z.object({
        title: z.string().min(3),
        context: z.string().min(3),
        decision: z.string().min(3),
        alternatives: z.string().min(3),
        why: z.string().min(3),
        trigger: TriggerEnum,
      }),
    )
    .max(3),
});
const DecisionsJsonSchema = zodToJsonSchema(DecisionsOutputSchema);

export interface DecisionsArgs {
  ctx: RunContext;
}

export async function decisions(args: DecisionsArgs): Promise<StageResult> {
  const { ctx } = args;
  ctx.store.startStage(ctx.runId, "decisions");
  try {
    const specBody = await safeRead(ctx.paths.spec);
    if (!specBody.trim()) {
      // Nothing to extract from — record as skipped so we don't rerun.
      ctx.store.finishStage(ctx.runId, "decisions", {
        status: "skipped",
        artifact_path: null,
      });
      return { ok: true };
    }

    const findings = ctx.store.listFindings(ctx.runId);
    const commits = await readBranchCommits(ctx);
    const priorBlock = await readDecisionsTail(ctx.root, 10);

    const prompt = buildPrompt({
      runId: ctx.runId,
      specBody,
      findings,
      commits,
      priorBlock,
      workdir: ctx.paths.workdir,
    });
    const systemPrompt = await loadPrompt("decisions");

    const res = await runClaude({
      ctx,
      stage: "decisions",
      prompt,
      systemPrompt,
      cwd: ctx.paths.workdir,
      permissionMode: "bypassPermissions",
      settingSources: ["project"],
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      disallowedTools: [
        "Edit",
        "Write",
        "NotebookEdit",
        "TodoWrite",
        "WebFetch",
        "WebSearch",
      ],
      jsonSchema: DecisionsJsonSchema,
      maxTurns: 8,
    });

    const parsed = DecisionsOutputSchema.parse(pickStructured(res));
    const isoDate = new Date().toISOString();
    const entries: DecisionEntry[] = parsed.entries.map((e) => ({
      isoDate,
      title: e.title,
      context: e.context,
      decision: e.decision,
      alternatives: e.alternatives,
      why: e.why,
      trigger: e.trigger,
      runId: ctx.runId,
    }));

    if (entries.length > 0) {
      await appendDecisionEntries(ctx.root, entries);
    }

    // cost, usage, and session are persisted incrementally by runClaude.
    ctx.store.transaction(() => {
      ctx.store.finishStage(ctx.runId, "decisions", {
        status: "completed",
        artifact_path: entries.length > 0 ? decisionsPathLabel(ctx) : null,
      });
      ctx.store.appendEvent(ctx.runId, "decisions", "decisions_extracted", {
        count: entries.length,
      });
    });

    return { ok: true, cost: res.costUsd, data: { count: entries.length } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn("decisions stage failed (non-fatal)", { err: msg });
    ctx.store.finishStage(ctx.runId, "decisions", {
      status: "failed",
      error: msg,
    });
    // Non-fatal: the run already delivered. Return ok=true so the
    // pipeline treats this as best-effort.
    return { ok: true, error: msg };
  }
}

function buildPrompt(args: {
  runId: string;
  specBody: string;
  findings: FindingRow[];
  commits: string;
  priorBlock: string;
  workdir: string;
}): string {
  const findingsBlock =
    args.findings.length === 0
      ? "_No findings were produced in this run._"
      : args.findings
          .map(
            (f) =>
              `- [${f.severity}] ${f.critic}: ${f.title}  \n  fingerprint: \`${f.fingerprint}\`  \n  iteration: ${f.iteration}`,
          )
          .join("\n");
  const commitsBlock = args.commits.trim() || "_No commits captured._";
  const priorSection = args.priorBlock.trim()
    ? args.priorBlock
    : "_No prior decisions recorded yet._";
  return [
    `Run: ${args.runId}`,
    `Workdir: ${args.workdir}`,
    ``,
    `## Prior decisions`,
    priorSection,
    ``,
    `## spec.md`,
    args.specBody.trim(),
    ``,
    `## Findings from this run`,
    findingsBlock,
    ``,
    `## Commits on this run's branch`,
    "```",
    commitsBlock,
    "```",
    ``,
    `Extract 0–3 non-obvious decisions per the system prompt's gating rules. Prefer quality over coverage. Return the JSON block only.`,
  ].join("\n");
}

async function readBranchCommits(ctx: RunContext): Promise<string> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["log", "--pretty=format:%h %s", "-n", "50"],
      { cwd: ctx.paths.workdir, maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return "";
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function decisionsPathLabel(ctx: RunContext): string {
  // Path relative to the project root, so the stage artifact_path
  // points at the shared .mill/decisions.md rather than the per-run
  // directory. The file itself is cross-run state.
  return `${ctx.root}/.mill/decisions.md`;
}
