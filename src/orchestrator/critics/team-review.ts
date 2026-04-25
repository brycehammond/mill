// Team-mode review: one `claude` subprocess ("review lead") spawns the three
// LLM critics (security/correctness/ux) as *parallel subagents* via the
// Agent tool in a single session. The critics are regular subagents, not
// team members — no TeamCreate, no SendMessage, no team_name. Each Agent
// call is synchronous from the lead: the subagent runs to completion, the
// Agent tool returns the subagent's final text (a fenced JSON findings
// block), and the lead parses those returns before emitting aggregated
// structured output.
//
// Why not use actual Claude Code agent teams? Teams route teammate replies
// as new conversation turns on the lead. Combined with --json-schema, the
// lead is forced to satisfy the output schema at the end of every turn —
// including its first turn, which ends right after spawning the team,
// before any teammate has had a chance to reply. That produces premature
// finalization with empty ERROR stubs. Parallel Agent calls sidestep this:
// one turn, all critics run, lead emits aggregated output once.
//
// tests + adversarial critics stay on the subprocess-per-critic path (tests
// is mechanical, adversarial is codex-backed) and are merged in by review.ts
// after this call returns.
//
// On failure (parse error, subprocess hang, etc.) the caller decides whether
// to hard-fail (MILL_AGENT_TEAMS=on) or fall back to the subprocess-per-
// critic path (MILL_AGENT_TEAMS=auto).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  Finding,
  RunContext,
  Severity,
  TokenUsage,
} from "../../core/index.js";
import { ZERO_USAGE } from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import {
  pickStructured,
  runClaude,
  type AgentDef,
} from "../claude-cli.js";

const FindingSchema = z.object({
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  title: z.string(),
  evidence: z.string(),
  suggested_fix: z.string(),
});

const TeamReviewOutputSchema = z.object({
  critics: z.array(
    z.object({
      name: z.enum(["security", "correctness", "ux"]),
      findings: z.array(FindingSchema),
      summary: z.string(),
    }),
  ),
});
const TeamReviewJsonSchema = zodToJsonSchema(TeamReviewOutputSchema);

type TeamCritic = "security" | "correctness" | "ux";
const TEAM_CRITICS: readonly TeamCritic[] = ["security", "correctness", "ux"];

// Tools each critic subagent is allowed to use. Read-only set — Edit/Write
// etc. are omitted deliberately. Bash sub-command restrictions (cat/rg only)
// are enforced by the per-run settings.json deny list, which applies to all
// agents in the session regardless of this whitelist.
const CRITIC_TOOLS = ["Read", "Glob", "Grep", "Bash"];

// Tools the lead needs: Agent to spawn critics in parallel, Read to look at
// the spec/design files the harness handed it. No Edit/Write — the lead
// stays at the orchestration layer. Team/SendMessage intentionally omitted
// (see the file header comment for why).
const LEAD_TOOLS = ["Agent", "Read"];

const LEAD_DISALLOWED = [
  "Edit",
  "Write",
  "NotebookEdit",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

export interface TeamReviewArgs {
  ctx: RunContext;
  iteration: number;
  specBody: string;
  designBody: string;
}

export interface TeamReviewOutput {
  // Every critic's findings, in the order the critics reported. Downstream
  // code treats these identically to the per-subprocess CriticResult findings.
  findings: Finding[];
  summaries: { critic: string; summary: string }[];
  reportPaths: string[];
  cost: number;
  usage: TokenUsage;
  // True if any critic returned unparseable output or the overall stage
  // errored out but produced enough to be useful. review.ts treats this
  // the same as a failed promise from the per-critic path.
  anyFailed: boolean;
}

// Runs the lead + three critics in one claude session. Commits cost, usage,
// and findings rows to the DB itself (mirroring runCritic's transactional
// contract). The returned CriticResult-ish shape is what review.ts would
// have produced for the three LLM critics in the subprocess path.
export async function runTeamReview(args: TeamReviewArgs): Promise<TeamReviewOutput> {
  const { ctx, iteration, specBody, designBody } = args;

  const [leadPrompt, securityPrompt, correctnessPrompt, uxPrompt] =
    await Promise.all([
      loadPrompt("review-lead"),
      loadPrompt("critic-security"),
      loadPrompt("critic-correctness"),
      loadPrompt("critic-ux"),
    ]);

  const agentsConfig: Record<string, AgentDef> = {
    security: {
      description:
        "Read-only security critic. Looks for injection, authn/authz, secret handling, and unsafe defaults.",
      prompt: securityPrompt,
      tools: CRITIC_TOOLS,
    },
    correctness: {
      description:
        "Read-only correctness critic. Looks for bugs, broken contracts, wrong logic, missing cases.",
      prompt: correctnessPrompt,
      tools: CRITIC_TOOLS,
    },
    ux: {
      description:
        "Read-only UX critic. Looks for visible user-facing issues, error messages, accessibility basics.",
      prompt: uxPrompt,
      tools: CRITIC_TOOLS,
    },
  };

  const slot = "review:lead";
  const prior = ctx.store.getSession(ctx.runId, slot);

  const userMessage = buildLeadPrompt({
    ctx,
    iteration,
    specBody,
    designBody,
    resumed: Boolean(prior),
  });

  const res = await runClaude({
    ctx,
    stage: "review",
    // Team mode persists one session slot (the lead); per-critic slots
    // are not used here. runClaude saves into review:lead so --resume
    // hits the lead on subsequent iterations.
    sessionSlot: slot,
    prompt: userMessage,
    systemPrompt: leadPrompt,
    systemPromptMode: "replace",
    agentsConfig,
    cwd: ctx.paths.workdir,
    permissionMode: "bypassPermissions",
    settingSources: ["project"],
    allowedTools: LEAD_TOOLS,
    disallowedTools: LEAD_DISALLOWED,
    jsonSchema: TeamReviewJsonSchema,
    resume: prior?.sessionId,
    // Higher than per-critic subprocess (40) because the lead does
    // orchestration turns + three subagents' worth of work + optional
    // cross-critic chatter, all in one session.
    maxTurns: 80,
  });

  const parsed = TeamReviewOutputSchema.parse(pickStructured(res));

  // Detect an all-empty/all-error output: every critic returned an empty
  // findings array AND a summary starting with "ERROR". That signals the
  // lead failed to parse every critic's reply, i.e. team-mode is broken.
  // MILL_AGENT_TEAMS=auto falls back to subprocesses, =on throws. Real "no
  // findings" reviews (clean code) have non-ERROR summaries and don't trip.
  const allEmpty =
    parsed.critics.length > 0 &&
    parsed.critics.every(
      (c) => c.findings.length === 0 && /^\s*error\b/i.test(c.summary),
    );
  if (allEmpty) {
    throw new Error(
      "team review produced zero findings from every critic (lead failed to parse critic replies)",
    );
  }

  // Make sure every expected critic is represented, even if the lead dropped
  // one (the zod schema only constrains types, not completeness). Missing
  // critics become an empty-findings entry flagged as failed.
  const byName = new Map(parsed.critics.map((c) => [c.name, c]));
  const reportDir = join(ctx.paths.reviewsDir, String(iteration));
  await mkdir(reportDir, { recursive: true });

  const findings: Finding[] = [];
  const summaries: { critic: string; summary: string }[] = [];
  const reportPaths: string[] = [];
  let anyFailed = false;

  for (const critic of TEAM_CRITICS) {
    const entry = byName.get(critic);
    if (!entry) {
      anyFailed = true;
      summaries.push({ critic, summary: "ERROR: critic missing from lead's output" });
      continue;
    }
    const mapped: Finding[] = entry.findings.map((f) => ({
      critic,
      severity: f.severity as Severity,
      title: f.title,
      evidence: f.evidence,
      suggested_fix: f.suggested_fix,
    }));
    findings.push(...mapped);
    summaries.push({ critic, summary: entry.summary });
    const reportPath = join(reportDir, `${critic}.md`);
    await writeFile(reportPath, renderCriticReport(critic, entry), "utf8");
    reportPaths.push(reportPath);
  }

  // cost, usage, and the lead session are persisted incrementally by
  // runClaude. Findings go in one transaction so a crash between inserts
  // leaves a coherent set. Per-critic session resume is not used in team
  // mode — the lead carries context iteration-to-iteration instead.
  ctx.store.transaction(() => {
    for (const [i, critic] of TEAM_CRITICS.entries()) {
      const entry = byName.get(critic);
      if (!entry) continue;
      const reportPath = reportPaths[i]!;
      for (const f of entry.findings) {
        ctx.store.insertFinding({
          run_id: ctx.runId,
          iteration,
          critic,
          severity: f.severity as Severity,
          title: f.title,
          detail_path: reportPath,
        });
      }
    }
  });

  return {
    findings,
    summaries,
    reportPaths,
    cost: res.costUsd,
    usage: res.usage,
    anyFailed,
  };
}

function buildLeadPrompt(args: {
  ctx: RunContext;
  iteration: number;
  specBody: string;
  designBody: string;
  resumed: boolean;
}): string {
  const { ctx, iteration, specBody, designBody, resumed } = args;
  const lead = resumed
    ? `Review iteration ${iteration}. The workdir has been updated since the last pass. Re-run all three critics in full — don't assume prior findings carry forward.`
    : `Review iteration ${iteration}. First pass on this workdir.`;
  return [
    lead,
    ``,
    `Workdir: ${ctx.paths.workdir}`,
    ``,
    `## spec.md`,
    specBody.trim(),
    ``,
    `## design`,
    designBody.trim() || "(no design doc)",
    ``,
    `Spawn the three critics in parallel via three Agent tool calls in a single message (subagent_type = "security", "correctness", "ux"). Each critic's final output is a fenced JSON block with {findings, summary}. After all three Agent calls return, parse their outputs and emit the aggregated structured JSON.`,
  ].join("\n");
}

function renderCriticReport(
  critic: TeamCritic,
  entry: { findings: z.infer<typeof FindingSchema>[]; summary: string },
): string {
  const header = `# ${critic} review\n\n${entry.summary}\n`;
  if (entry.findings.length === 0) return `${header}\n_No findings._\n`;
  const body = entry.findings
    .map(
      (f) =>
        `## [${f.severity}] ${f.title}\n\n**Evidence**\n\n${f.evidence}\n\n**Suggested fix**\n\n${f.suggested_fix}\n`,
    )
    .join("\n");
  return `${header}\n${body}`;
}

export { ZERO_USAGE };
