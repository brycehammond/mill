import { readFile, writeFile } from "node:fs/promises";
import type {
  RunContext,
  StageResult,
  Finding,
  TokenUsage,
} from "../../core/index.js";
import {
  appendJournalEntry,
  atLeast,
  type RunMode,
} from "../../core/index.js";
import { gitDiffStat } from "../git.js";
import {
  importWorkdirBranchToParent,
  promoteWorkdir,
  resolvePromoteMode,
  type BranchImportResult,
  type PromoteResult,
} from "../promote.js";

export interface DeliverArgs {
  ctx: RunContext;
  iterationCount: number;
  unresolvedHighFindings: Finding[];
  verifyPass: boolean;
  verifyReportPath: string | null;
  endedAt: number;
  startedAt: number;
}

interface WorktreeInfo {
  branch: string;
  baseBranch: string | null;
}

export async function deliver(args: DeliverArgs): Promise<StageResult> {
  const { ctx } = args;
  ctx.store.startStage(ctx.runId, "deliver");
  try {
    const run = ctx.store.getRun(ctx.runId);
    const stages = ctx.store.listStages(ctx.runId);

    const worktree = findWorktreeInfo(ctx);
    let diffStat = "";

    if (ctx.mode === "edit" && worktree && worktree.baseBranch) {
      diffStat = await gitDiffStat(
        ctx.paths.workdir,
        `${worktree.baseBranch}..HEAD`,
      );
    }

    const passed =
      args.verifyPass &&
      args.unresolvedHighFindings.filter((f) => atLeast(f.severity, "HIGH"))
        .length === 0;

    // New-mode promotion: copy the workdir contents up into the project
    // root so the result is "right there" instead of buried under
    // `.mill/runs/<id>/workdir/`. Edit mode already commits on its own
    // branch in the user's worktree, so it isn't promoted.
    let promoteResult: PromoteResult | null = null;
    if (ctx.mode === "new" && passed) {
      try {
        promoteResult = await promoteWorkdir({
          workdir: ctx.paths.workdir,
          root: ctx.root,
          mode: resolvePromoteMode(),
        });
        ctx.store.appendEvent(ctx.runId, "deliver", "workdir_promoted", {
          ...promoteResult,
          root: ctx.root,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn("workdir promotion failed", { err: msg });
        ctx.store.appendEvent(ctx.runId, "deliver", "workdir_promote_failed", {
          error: msg,
        });
      }
    }

    // Bring the workdir's branch into the parent repo for both modes.
    // Edit mode: branch is already in the parent's refs (worktree shares
    // the object DB), so this is effectively a no-op force-fetch — the
    // intent is to verify and surface the branch. New mode: imports the
    // workdir's independent history into the parent repo, init'ing
    // `root/.git` if missing. Best-effort: failures are logged but never
    // flip the run to failed.
    let branchImport: BranchImportResult | null = null;
    if (passed) {
      try {
        branchImport = await importWorkdirBranchToParent({
          workdir: ctx.paths.workdir,
          root: ctx.root,
          branch: worktree?.branch ?? null,
        });
        ctx.store.appendEvent(
          ctx.runId,
          "deliver",
          branchImport.imported ? "branch_imported" : "branch_import_skipped",
          { ...branchImport, root: ctx.root },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn("branch import failed", { err: msg });
        ctx.store.appendEvent(ctx.runId, "deliver", "branch_import_failed", {
          error: msg,
        });
      }
    }

    const durationMs = args.endedAt - args.startedAt;
    const runUsage = run
      ? {
          input: run.total_input_tokens,
          cache_creation: run.total_cache_creation_tokens,
          cache_read: run.total_cache_read_tokens,
          output: run.total_output_tokens,
        }
      : ctx.costs.runUsageTotal();

    const md = renderDelivery({
      runId: ctx.runId,
      kind: ctx.kind,
      mode: ctx.mode,
      totalCostUsd: run?.total_cost_usd ?? ctx.costs.runTotal(),
      totalUsage: runUsage,
      durationMs,
      iterationCount: args.iterationCount,
      unresolvedHighFindings: args.unresolvedHighFindings,
      verifyPass: args.verifyPass,
      verifyReportPath: args.verifyReportPath,
      workdir: ctx.paths.workdir,
      worktree,
      diffStat,
      promoteRoot: promoteResult?.promoted ? ctx.root : null,
      promoteSkipReason:
        promoteResult && !promoteResult.promoted ? promoteResult.reason : null,
      branchImport,
      root: ctx.root,
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

    // Journal is human-readable + prompt-ingestible by future runs. A
    // write failure must not fail the run, so it's its own try/catch.
    try {
      const requirement = await readFirstLine(ctx.paths.requirement);
      await appendJournalEntry(ctx.stateDir, {
        runId: ctx.runId,
        mode: ctx.mode,
        isoDate: new Date(args.endedAt).toISOString(),
        requirementFirstLine: requirement,
        branch: worktree?.branch ?? null,
        verify: passed ? "pass" : "fail",
        costUsd: run?.total_cost_usd ?? ctx.costs.runTotal(),
      });
    } catch (err) {
      ctx.logger.warn("journal append failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    ctx.store.transaction(() => {
      ctx.store.updateRun(ctx.runId, { status: passed ? "completed" : "failed" });
      ctx.store.finishStage(ctx.runId, "deliver", {
        status: "completed",
        artifact_path: ctx.paths.delivery,
      });
    });
    // Phase 3: emit a terminal event after the status flip lands so
    // notify.ts (and any other bus subscriber) can fan out webhooks.
    // The transaction above already committed the row update; this is
    // a separate INSERT and a bus publish. Failures here must not flip
    // the run back to failed — the delivery already succeeded.
    try {
      ctx.store.appendEvent(
        ctx.runId,
        "deliver",
        passed ? "run_completed" : "run_failed",
        {
          run_id: ctx.runId,
          summary: passed
            ? "Run completed successfully"
            : "Run failed at delivery",
          unresolved_high_count: args.unresolvedHighFindings.length,
          verify_pass: args.verifyPass,
        },
      );
    } catch (err) {
      ctx.logger.warn("terminal event publish failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
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

// Scan the event log for the `worktree_created` intake event written
// in edit-mode runs. Bounded by the number of events in a run (small).
function findWorktreeInfo(ctx: RunContext): WorktreeInfo | null {
  if (ctx.mode !== "edit") return null;
  const events = ctx.store.tailEvents(ctx.runId, 0, 1000);
  for (const e of events) {
    if (e.kind === "worktree_created") {
      try {
        const p = JSON.parse(e.payload_json) as {
          branch?: unknown;
          baseBranch?: unknown;
        };
        if (typeof p.branch === "string") {
          return {
            branch: p.branch,
            baseBranch: typeof p.baseBranch === "string" ? p.baseBranch : null,
          };
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

async function readFirstLine(path: string): Promise<string> {
  try {
    const body = await readFile(path, "utf8");
    const first = body.split("\n").find((l) => l.trim().length > 0) ?? "";
    return first.slice(0, 200).trim();
  } catch {
    return "";
  }
}

function renderDelivery(d: {
  runId: string;
  kind: string | null;
  mode: RunMode;
  totalCostUsd: number;
  totalUsage: TokenUsage;
  durationMs: number;
  iterationCount: number;
  unresolvedHighFindings: Finding[];
  verifyPass: boolean;
  verifyReportPath: string | null;
  workdir: string;
  worktree: WorktreeInfo | null;
  diffStat: string;
  // New-mode only: where the workdir was promoted to (parent root). Null
  // when promotion was skipped or didn't run.
  promoteRoot: string | null;
  promoteSkipReason: string | null;
  branchImport: BranchImportResult | null;
  root: string;
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

  const changesSection =
    d.mode === "edit" && d.worktree
      ? renderChangesSection({
          worktree: d.worktree,
          workdir: d.workdir,
          runId: d.runId,
          diffStat: d.diffStat,
          branchImport: d.branchImport,
          root: d.root,
        })
      : d.branchImport && d.branchImport.imported && d.branchImport.branch
        ? renderNewModeBranchSection({
            branch: d.branchImport.branch,
            outcome: d.branchImport.outcome,
            root: d.root,
          })
        : "";

  const sections: string[] = [
    `# Delivery — ${d.runId}`,
    ``,
    `- **Kind**: ${d.kind ?? "unknown"}`,
    `- **Mode**: ${d.mode}`,
    `- **Status**: ${d.verifyPass && d.unresolvedHighFindings.length === 0 ? "✅ shipped" : "⚠️  delivered with open issues"}`,
    `- **Total cost**: $${d.totalCostUsd.toFixed(4)}`,
    `- **Total tokens**: ${totalTokens.toLocaleString()} (input ${d.totalUsage.input.toLocaleString()}, cache-creation ${d.totalUsage.cache_creation.toLocaleString()}, cache-read ${d.totalUsage.cache_read.toLocaleString()}, output ${d.totalUsage.output.toLocaleString()})`,
    `- **Wall clock**: ${wallClock}`,
    `- **Implement iterations**: ${d.iterationCount}`,
    `- **Verify result**: ${d.verifyPass ? "PASS" : "FAIL"}${d.verifyReportPath ? ` — see ${d.verifyReportPath}` : ""}`,
    `- **Workdir**: ${d.workdir}`,
  ];

  if (d.promoteRoot) {
    sections.push(`- **Promoted to**: ${d.promoteRoot}`);
  } else if (d.promoteSkipReason) {
    sections.push(`- **Promote skipped**: ${d.promoteSkipReason}`);
  }
  sections.push(``);

  if (changesSection) {
    sections.push(changesSection, ``);
  }

  sections.push(
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
  );

  return sections.join("\n");
}

function renderChangesSection(args: {
  worktree: WorktreeInfo;
  workdir: string;
  runId: string;
  diffStat: string;
  branchImport: BranchImportResult | null;
  root: string;
}): string {
  const { worktree, workdir, runId, diffStat, branchImport, root } = args;
  const base = worktree.baseBranch ?? "HEAD";
  const review = `git -C ${root} diff ${base}..${worktree.branch}`;
  const switchCmd = `git -C ${root} switch ${worktree.branch}`;
  const merge = `git -C ${root} merge ${worktree.branch}`;
  const cleanup = `git -C ${root} worktree remove ${workdir}`;
  const importedNote = branchImport
    ? branchImport.imported
      ? `_Branch is on the parent repo at \`${root}\`._`
      : `_Branch import skipped: ${branchImport.outcome}._`
    : "";
  const lines: string[] = [
    `## Changes`,
    ``,
    `- **Branch**: \`${worktree.branch}\` (off \`${base}\`)`,
    `- **Workdir**: \`${workdir}\``,
  ];
  if (importedNote) lines.push(``, importedNote);
  lines.push(``);
  lines.push(`### Diff summary`, ``, "```", diffStat || "(no diff)", "```", ``);
  lines.push(
    `### Review`,
    "```sh",
    review,
    "```",
    ``,
    `### Switch & merge`,
    "```sh",
    `${switchCmd}`,
    `# or, from the base branch:`,
    `${merge}`,
    "```",
    ``,
    `### Cleanup workdir`,
    "```sh",
    cleanup,
    "```",
  );
  // runId is surfaced in the heading already; keep this function
  // self-contained so it can grow without re-threading ctx.
  void runId;
  return lines.join("\n");
}

// New-mode equivalent of renderChangesSection. Edit mode walks off a
// known base branch; new mode imported the workdir's independent
// history with no prior base, so the section is simpler.
function renderNewModeBranchSection(args: {
  branch: string;
  outcome: string;
  root: string;
}): string {
  const { branch, outcome, root } = args;
  const log = `git -C ${root} log --oneline ${branch}`;
  const switchCmd = `git -C ${root} switch ${branch}`;
  const lines: string[] = [
    `## Changes`,
    ``,
    `- **Branch**: \`${branch}\` (imported into \`${root}\`)`,
    `- **Import outcome**: ${outcome}`,
    ``,
    `### Browse history`,
    "```sh",
    log,
    "```",
    ``,
    `### Switch`,
    "```sh",
    switchCmd,
    "```",
  ];
  return lines.join("\n");
}

function fmtCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
