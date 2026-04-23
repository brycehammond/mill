import { writeFile } from "node:fs/promises";
import type { RunContext, StageResult, Finding } from "../../core/index.js";
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
    const md = renderDelivery({
      runId: ctx.runId,
      kind: ctx.kind,
      totalCostUsd: run?.total_cost_usd ?? ctx.budget.runTotal(),
      durationMs,
      iterationCount: args.iterationCount,
      unresolvedHighFindings: args.unresolvedHighFindings,
      verifyPass: args.verifyPass,
      verifyReportPath: args.verifyReportPath,
      workdir: ctx.paths.workdir,
      stages: stages.map((s) => ({
        name: s.name,
        status: s.status,
        cost_usd: s.cost_usd,
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
  durationMs: number;
  iterationCount: number;
  unresolvedHighFindings: Finding[];
  verifyPass: boolean;
  verifyReportPath: string | null;
  workdir: string;
  stages: { name: string; status: string; cost_usd: number; artifact_path: string | null }[];
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
        `| ${s.name} | ${s.status} | $${s.cost_usd.toFixed(4)} | ${s.artifact_path ?? "—"} |`,
    )
    .join("\n");

  return [
    `# Delivery — ${d.runId}`,
    ``,
    `- **Kind**: ${d.kind ?? "unknown"}`,
    `- **Status**: ${d.verifyPass && d.unresolvedHighFindings.length === 0 ? "✅ shipped" : "⚠️  delivered with open issues"}`,
    `- **Total cost**: $${d.totalCostUsd.toFixed(4)}`,
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
    `| stage | status | cost | artifact |`,
    `|-------|--------|------|----------|`,
    stageTable,
    ``,
  ].join("\n");
}
