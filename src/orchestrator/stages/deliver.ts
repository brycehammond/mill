import { writeFile } from "node:fs/promises";
import type {
  RunContext,
  StageResult,
  Finding,
  TokenUsage,
} from "../../core/index.js";
import { atLeast } from "../../core/index.js";

export interface DeliverArgs {
  ctx: RunContext;
  iterationCount: number;
  unresolvedHighFindings: Finding[];
  verifyPass: boolean;
  verifyReportPath: string | null;
  endedAt: number;
  startedAt: number;
}

export async function deliver(args: DeliverArgs): Promise<StageResult> {
  const { ctx } = args;
  ctx.store.startStage(ctx.runId, "deliver");
  try {
    const run = ctx.store.getRun(ctx.runId);
    const stages = ctx.store.listStages(ctx.runId);

    const durationMs = args.endedAt - args.startedAt;
    const runUsage = run
      ? {
          input: run.total_input_tokens,
          cache_creation: run.total_cache_creation_tokens,
          cache_read: run.total_cache_read_tokens,
          output: run.total_output_tokens,
        }
      : ctx.budget.runUsageTotal();
    const md = renderDelivery({
      runId: ctx.runId,
      kind: ctx.kind,
      totalCostUsd: run?.total_cost_usd ?? ctx.budget.runTotal(),
      totalUsage: runUsage,
      durationMs,
      iterationCount: args.iterationCount,
      unresolvedHighFindings: args.unresolvedHighFindings,
      verifyPass: args.verifyPass,
      verifyReportPath: args.verifyReportPath,
      workdir: ctx.paths.workdir,
      // `deliver` is still marked `running` in the store here — finishStage
      // runs below so the updateRun + finishStage pair can share one
      // transaction. Patch the rendered row to reflect the terminal state
      // we're about to commit.
      stages: stages.map((s) => ({
        name: s.name,
        status: s.name === "deliver" ? "completed" : s.status,
        cost_usd: s.cost_usd,
        input_tokens: s.input_tokens,
        cache_creation_tokens: s.cache_creation_tokens,
        cache_read_tokens: s.cache_read_tokens,
        output_tokens: s.output_tokens,
        artifact_path: s.artifact_path ?? null,
      })),
    });

    await writeFile(ctx.paths.delivery, md, "utf8");

    const passed =
      args.verifyPass &&
      args.unresolvedHighFindings.filter((f) => atLeast(f.severity, "HIGH"))
        .length === 0;

    ctx.store.transaction(() => {
      ctx.store.updateRun(ctx.runId, { status: passed ? "completed" : "failed" });
      ctx.store.finishStage(ctx.runId, "deliver", {
        status: "completed",
        artifact_path: ctx.paths.delivery,
      });
    });
    return { ok: passed, data: { delivery: ctx.paths.delivery, passed } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.store.finishStage(ctx.runId, "deliver", {
      status: "failed",
      error: msg,
    });
    return { ok: false, error: msg };
  }
}

function renderDelivery(d: {
  runId: string;
  kind: string | null;
  totalCostUsd: number;
  totalUsage: TokenUsage;
  durationMs: number;
  iterationCount: number;
  unresolvedHighFindings: Finding[];
  verifyPass: boolean;
  verifyReportPath: string | null;
  workdir: string;
  stages: {
    name: string;
    status: string;
    cost_usd: number;
    input_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    output_tokens: number;
    artifact_path: string | null;
  }[];
}): string {
  const wallClock =
    d.durationMs > 3600_000
      ? `${(d.durationMs / 3600_000).toFixed(2)} h`
      : `${(d.durationMs / 60_000).toFixed(2)} min`;
  const findingsBlock = d.unresolvedHighFindings.length
    ? d.unresolvedHighFindings
        .map(
          (f, i) =>
            `${i + 1}. **[${f.severity}] ${f.critic}: ${f.title}**\n   ${f.evidence}`,
        )
        .join("\n\n")
    : "_None — all HIGH/CRITICAL findings resolved._";

  const stageTable = d.stages
    .map(
      (s) =>
        `| ${s.name} | ${s.status} | $${s.cost_usd.toFixed(4)} | ${fmtCompact(s.input_tokens)} | ${fmtCompact(s.cache_creation_tokens)} | ${fmtCompact(s.cache_read_tokens)} | ${fmtCompact(s.output_tokens)} | ${s.artifact_path ?? "—"} |`,
    )
    .join("\n");

  const totalTokens =
    d.totalUsage.input +
    d.totalUsage.cache_creation +
    d.totalUsage.cache_read +
    d.totalUsage.output;

  return [
    `# Delivery — ${d.runId}`,
    ``,
    `- **Kind**: ${d.kind ?? "unknown"}`,
    `- **Status**: ${d.verifyPass && d.unresolvedHighFindings.length === 0 ? "✅ shipped" : "⚠️  delivered with open issues"}`,
    `- **Total cost**: $${d.totalCostUsd.toFixed(4)}`,
    `- **Total tokens**: ${totalTokens.toLocaleString()} (input ${d.totalUsage.input.toLocaleString()}, cache-creation ${d.totalUsage.cache_creation.toLocaleString()}, cache-read ${d.totalUsage.cache_read.toLocaleString()}, output ${d.totalUsage.output.toLocaleString()})`,
    `- **Wall clock**: ${wallClock}`,
    `- **Implement iterations**: ${d.iterationCount}`,
    `- **Verify result**: ${d.verifyPass ? "PASS" : "FAIL"}${d.verifyReportPath ? ` — see ${d.verifyReportPath}` : ""}`,
    `- **Workdir**: ${d.workdir}`,
    ``,
    `## Unresolved HIGH/CRITICAL findings`,
    ``,
    findingsBlock,
    ``,
    `## Stages`,
    ``,
    `| stage | status | cost | in | cache-create | cache-read | out | artifact |`,
    `|-------|--------|------|----|--------------|------------|-----|----------|`,
    stageTable,
    ``,
  ].join("\n");
}

function fmtCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
