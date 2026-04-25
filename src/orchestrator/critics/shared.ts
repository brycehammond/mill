import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  CriticName,
  Finding,
  RunContext,
  Severity,
  TokenUsage,
} from "../../core/index.js";
import { ZERO_USAGE } from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { pickStructured, runClaude } from "../claude-cli.js";

const CriticOutputSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
      title: z.string(),
      evidence: z.string(),
      suggested_fix: z.string(),
    }),
  ),
  summary: z.string(),
});
const CriticJsonSchema = zodToJsonSchema(CriticOutputSchema);

export interface CriticResult {
  findings: Finding[];
  summary: string;
  cost: number;
  // Token counts for the single claude call backing this critic. For the
  // adversarial critic (codex-backed), usage is zero — codex billing is
  // separate and not in the TokenUsage model.
  usage: TokenUsage;
  sessionId: string;
  reportPath: string;
}

export { ZERO_USAGE };

export interface RunCriticArgs {
  ctx: RunContext;
  iteration: number;
  critic: CriticName;
  specBody: string;
  designBody: string;
}

export async function runCritic(args: RunCriticArgs): Promise<CriticResult> {
  const { ctx, iteration, critic, specBody, designBody } = args;
  const systemPrompt = await loadPrompt(`critic-${critic}`);
  const slot = `review:${critic}`;
  const prior = ctx.store.getSession(ctx.runId, slot);

  const prompt = buildCriticPrompt({
    critic,
    iteration,
    workdir: ctx.paths.workdir,
    specBody,
    designBody,
    resumed: Boolean(prior),
  });

  const res = await runClaude({
    ctx,
    stage: "review",
    // Each critic resumes its own session across review iterations. The
    // slot is what runClaude saves into so --resume wires up correctly.
    sessionSlot: slot,
    prompt,
    systemPrompt,
    // Critics fully own the system prompt — using "replace" drops
    // Claude Code's default coder framing (which nudges toward writing
    // tests, tracking todos, fixing code) so the critic stays on its
    // narrow job of judging what's there. Tool use still works because
    // tool-use formatting is model-intrinsic, not prompt-derived.
    systemPromptMode: "replace",
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
    jsonSchema: CriticJsonSchema,
    resume: prior?.sessionId,
    // Critics on a substantial codebase need plenty of Read/Glob/Grep
    // turns before they can form an opinion. 20 was tight for a few-
    // thousand-LOC project; 40 leaves room without giving the critic
    // license to wander.
    maxTurns: 40,
  });

  const parsed = CriticOutputSchema.parse(pickStructured(res));
  const findings: Finding[] = parsed.findings.map((f) => ({
    critic,
    severity: f.severity as Severity,
    title: f.title,
    evidence: f.evidence,
    suggested_fix: f.suggested_fix,
  }));

  const reportDir = join(ctx.paths.reviewsDir, String(iteration));
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${critic}.md`);
  await writeFile(reportPath, renderCriticReport(critic, parsed), "utf8");

  // cost, usage, and session are persisted incrementally by runClaude
  // (under slot `review:<critic>`). Findings go in a transaction here so
  // a crash between inserts leaves a coherent findings set.
  ctx.store.transaction(() => {
    for (const f of findings) {
      ctx.store.insertFinding({
        run_id: ctx.runId,
        iteration,
        critic,
        severity: f.severity,
        title: f.title,
        detail_path: reportPath,
      });
    }
  });

  return {
    findings,
    summary: parsed.summary,
    cost: res.costUsd,
    usage: res.usage,
    sessionId: res.sessionId,
    reportPath,
  };
}

function buildCriticPrompt(args: {
  critic: CriticName;
  iteration: number;
  workdir: string;
  specBody: string;
  designBody: string;
  resumed: boolean;
}): string {
  const lead = args.resumed
    ? `Review iteration ${args.iteration}. The workdir has been updated since your last pass. Re-review in full — do not assume prior findings are still present.`
    : `Review iteration ${args.iteration}. This is your first pass on this workdir.`;
  return [
    lead,
    ``,
    `Workdir: ${args.workdir}`,
    ``,
    `## spec.md`,
    args.specBody.trim(),
    ``,
    `## design`,
    args.designBody.trim() || "(no design doc)",
    ``,
    `Begin by listing files with Glob, then read anything that matters. Return your findings in the required JSON shape.`,
  ].join("\n");
}

function renderCriticReport(
  critic: CriticName,
  parsed: z.infer<typeof CriticOutputSchema>,
): string {
  const header = `# ${critic} review\n\n${parsed.summary}\n`;
  if (parsed.findings.length === 0) return `${header}\n_No findings._\n`;
  const body = parsed.findings
    .map(
      (f) =>
        `## [${f.severity}] ${f.title}\n\n**Evidence**\n\n${f.evidence}\n\n**Suggested fix**\n\n${f.suggested_fix}\n`,
    )
    .join("\n");
  return `${header}\n${body}`;
}
