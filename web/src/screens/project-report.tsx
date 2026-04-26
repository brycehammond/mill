import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api.js";
import {
  fmtAbsoluteTs,
  fmtDurationMs,
  fmtUsd,
} from "../components/format.js";
import {
  RunStatusBadge,
  SeverityBadge,
} from "../components/StatusBadge.js";
import { StageTimeline } from "../components/StageTimeline.js";
import { FindingsCounts } from "../components/FindingsCounts.js";
import { MarkdownProse } from "../components/MarkdownProse.js";
import { ErrorState, Loading, SectionHeading } from "./dashboard.js";
import type {
  LedgerEntry,
  ProjectCostByMonth,
  ProjectReportAggregates,
  ProjectStageRollup,
  ProfileData,
  Run,
  RunStatus,
  StageName,
  StitchProjectRef,
  WebhookRow,
} from "../types.js";

// Single read-only "everything we know about this project" page. The
// existing /projects/:id page stays focused on action (start a run,
// edit gates/webhooks); this page is the audit/overview surface.

const RECENT_RUN_DETAIL_COUNT = 8;

const STATUS_DISPLAY_ORDER: RunStatus[] = [
  "completed",
  "running",
  "queued",
  "awaiting_clarification",
  "awaiting_approval",
  "paused_budget",
  "failed",
  "killed",
];

export function ProjectReportScreen({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  const report = useQuery({
    queryKey: ["project-report", projectId],
    queryFn: () => api.getProjectReport(projectId),
  });
  const runs = useQuery({
    queryKey: ["project-report-runs", projectId],
    queryFn: () => api.listRuns({ project: projectId, limit: 1000 }),
  });
  const findings = useQuery({
    queryKey: ["project-findings", projectId],
    queryFn: () => api.projectFindings(projectId),
  });
  const gates = useQuery({
    queryKey: ["project-gates", projectId],
    queryFn: () => api.getProjectGates(projectId),
  });
  const webhooks = useQuery({
    queryKey: ["project-webhooks", projectId],
    queryFn: () => api.listProjectWebhooks(projectId),
  });

  // Recent-run detail: hydrate the last N runs eagerly (small N, simple
  // mental model). RunDetail is per-run; the queries dedupe by id, so a
  // user opening /runs/:id afterward reuses this cache.
  const recentRunIds = useMemo(() => {
    const list = runs.data ?? [];
    return list.slice(0, RECENT_RUN_DETAIL_COUNT).map((r) => r.id);
  }, [runs.data]);
  const recentDetails = useQueries({
    queries: recentRunIds.map((id) => ({
      queryKey: ["run", id],
      queryFn: () => api.getRun(id),
    })),
  });

  if (project.isLoading || report.isLoading) return <Loading />;
  if (project.isError) return <ErrorState error={project.error} />;
  if (report.isError) return <ErrorState error={report.error} />;
  const p = project.data!;
  const r = report.data!;

  return (
    <div className="space-y-8">
      <ReportHeader name={p.name} rootPath={p.root_path} projectId={projectId} />

      <LifetimeStats agg={r.aggregates} />

      <StatusBreakdown agg={r.aggregates} />

      <CostByMonthSection rows={r.cost_by_month} />

      <StageRollupsSection rows={r.stage_rollups} />

      <ConfigurationSection
        projectId={projectId}
        monthlyBudget={p.monthly_budget_usd}
        defaultConcurrency={p.default_concurrency}
        gates={gates.data?.stages ?? []}
        webhooks={webhooks.data?.webhooks ?? []}
        webhooksLoading={webhooks.isLoading}
        gatesLoading={gates.isLoading}
      />

      <AllRunsSection runs={runs.data ?? []} loading={runs.isLoading} />

      <RecentRunsDetailSection
        runIds={recentRunIds}
        details={recentDetails}
      />

      <FindingsLedgerSection
        entries={findings.data?.entries ?? []}
        loading={findings.isLoading}
      />

      <ProfileSection profileMd={r.state_files.profile_md} profileJson={r.state_files.profile_json} />

      <DecisionsSection source={r.state_files.decisions_md} />

      <JournalSection source={r.state_files.journal_md} />

      <StitchSection stitch={r.state_files.stitch} />
    </div>
  );
}

function ReportHeader({
  name,
  rootPath,
  projectId,
}: {
  name: string;
  rootPath: string;
  projectId: string;
}) {
  return (
    <header className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h1 className="font-mono text-lg">{name} — report</h1>
        <a
          href={`/projects/${encodeURIComponent(projectId)}`}
          className="text-xs text-blue-300 hover:text-blue-200 font-mono"
        >
          ← back to project
        </a>
      </div>
      <div className="text-xs text-ink-300 font-mono break-all">{rootPath}</div>
    </header>
  );
}

function LifetimeStats({ agg }: { agg: ProjectReportAggregates }) {
  const successPct =
    agg.success_rate == null ? "—" : `${Math.round(agg.success_rate * 100)}%`;
  const totalTokens =
    agg.total_input_tokens +
    agg.total_output_tokens +
    agg.total_cache_read_tokens +
    agg.total_cache_creation_tokens;
  return (
    <section>
      <SectionHeading>lifetime</SectionHeading>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        <Stat label="total runs" value={agg.total_runs.toLocaleString()} />
        <Stat label="total cost" value={fmtUsd(agg.total_cost_usd)} />
        <Stat label="avg cost / run" value={fmtUsd(agg.avg_cost_usd)} />
        <Stat
          label="avg duration"
          value={fmtDurationMs(agg.avg_duration_ms)}
        />
        <Stat label="success rate" value={successPct} />
        <Stat label="total tokens" value={totalTokens.toLocaleString()} />
        <Stat label="first run" value={fmtAbsoluteTs(agg.first_run_at)} />
        <Stat label="last run" value={fmtAbsoluteTs(agg.last_run_at)} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-ink-700 bg-ink-800 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-300">
        {label}
      </div>
      <div className="font-mono text-base mt-1">{value}</div>
    </div>
  );
}

function StatusBreakdown({ agg }: { agg: ProjectReportAggregates }) {
  const items = STATUS_DISPLAY_ORDER.filter((s) => agg.by_status[s] > 0);
  if (items.length === 0) return null;
  return (
    <section>
      <SectionHeading>by status</SectionHeading>
      <div className="rounded border border-ink-700 bg-ink-800 p-3 flex flex-wrap items-center gap-3">
        {items.map((s) => (
          <div key={s} className="flex items-center gap-1.5">
            <RunStatusBadge status={s} />
            <span className="font-mono text-sm">{agg.by_status[s]}</span>
          </div>
        ))}
        <span className="ml-auto text-xs text-ink-300 font-mono">
          new: {agg.by_mode.new} · edit: {agg.by_mode.edit}
        </span>
      </div>
    </section>
  );
}

function CostByMonthSection({ rows }: { rows: ProjectCostByMonth[] }) {
  const max = Math.max(0, ...rows.map((r) => r.cost_usd));
  return (
    <section>
      <SectionHeading>cost by month</SectionHeading>
      <div className="rounded border border-ink-700 bg-ink-800 divide-y divide-ink-700">
        {rows.map((row) => {
          const pct = max > 0 ? (row.cost_usd / max) * 100 : 0;
          return (
            <div
              key={row.month}
              className="px-3 py-1.5 grid grid-cols-[5rem_1fr_5rem_3rem] gap-3 items-center text-xs font-mono"
            >
              <span className="text-ink-300">{row.month}</span>
              <div className="h-2 bg-ink-900 rounded overflow-hidden">
                <div
                  className="h-full bg-emerald-700"
                  style={{ width: `${pct}%` }}
                  aria-hidden="true"
                />
              </div>
              <span className="text-right">{fmtUsd(row.cost_usd)}</span>
              <span className="text-right text-ink-300">
                {row.run_count} runs
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StageRollupsSection({ rows }: { rows: ProjectStageRollup[] }) {
  // Hide stages that were never run to keep the table compact, but keep
  // the canonical order from STAGE_ORDER for ones that did.
  const seen = rows.filter((r) => r.total_runs > 0);
  if (seen.length === 0) return null;
  return (
    <section>
      <SectionHeading>stages (lifetime)</SectionHeading>
      <div className="overflow-x-auto rounded border border-ink-700 bg-ink-800">
        <table className="w-full text-xs font-mono">
          <thead className="text-ink-300">
            <tr className="border-b border-ink-700">
              <th className="text-left px-3 py-2">stage</th>
              <th className="text-right px-3 py-2">runs</th>
              <th className="text-right px-3 py-2">completed</th>
              <th className="text-right px-3 py-2">failed</th>
              <th className="text-right px-3 py-2">total cost</th>
              <th className="text-right px-3 py-2">avg duration</th>
            </tr>
          </thead>
          <tbody>
            {seen.map((s) => (
              <tr key={s.name} className="border-b border-ink-700 last:border-b-0">
                <td className="px-3 py-1.5 text-ink-100">{s.name}</td>
                <td className="px-3 py-1.5 text-right">{s.total_runs}</td>
                <td className="px-3 py-1.5 text-right text-emerald-300">
                  {s.completed}
                </td>
                <td className="px-3 py-1.5 text-right text-rose-300">
                  {s.failed > 0 ? s.failed : "—"}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {fmtUsd(s.total_cost_usd)}
                </td>
                <td className="px-3 py-1.5 text-right text-ink-300">
                  {fmtDurationMs(s.avg_duration_ms)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ConfigurationSection({
  projectId,
  monthlyBudget,
  defaultConcurrency,
  gates,
  webhooks,
  gatesLoading,
  webhooksLoading,
}: {
  projectId: string;
  monthlyBudget: number | null;
  defaultConcurrency: number | null;
  gates: StageName[];
  webhooks: WebhookRow[];
  gatesLoading: boolean;
  webhooksLoading: boolean;
}) {
  return (
    <section>
      <SectionHeading
        right={
          <a
            href={`/projects/${encodeURIComponent(projectId)}`}
            className="text-xs text-blue-300 hover:text-blue-200 font-mono"
          >
            edit →
          </a>
        }
      >
        configuration
      </SectionHeading>
      <div className="rounded border border-ink-700 bg-ink-800 p-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-300">
            monthly budget
          </div>
          <div className="font-mono text-sm">
            {monthlyBudget != null ? fmtUsd(monthlyBudget) : "no cap"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-300">
            default concurrency
          </div>
          <div className="font-mono text-sm">
            {defaultConcurrency != null ? String(defaultConcurrency) : "global default"}
          </div>
        </div>
        <div className="sm:col-span-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-300">
            approval gates
          </div>
          <div className="font-mono text-sm mt-0.5">
            {gatesLoading
              ? "loading…"
              : gates.length === 0
                ? "none"
                : gates.join(" · ")}
          </div>
        </div>
        <div className="sm:col-span-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-300">
            webhooks
          </div>
          {webhooksLoading ? (
            <div className="font-mono text-sm">loading…</div>
          ) : webhooks.length === 0 ? (
            <div className="font-mono text-sm">none</div>
          ) : (
            <ul className="mt-0.5 space-y-0.5">
              {webhooks.map((w) => (
                <li key={w.id} className="font-mono text-xs break-all">
                  <span
                    className={
                      w.enabled ? "text-emerald-300" : "text-rose-300"
                    }
                  >
                    {w.enabled ? "● " : "○ "}
                  </span>
                  {w.url}{" "}
                  <span className="text-ink-300">
                    ({w.events.join(", ") || "no events"})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function AllRunsSection({
  runs,
  loading,
}: {
  runs: Run[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <section>
        <SectionHeading>all runs</SectionHeading>
        <div className="text-xs text-ink-300">loading…</div>
      </section>
    );
  }
  return (
    <section>
      <SectionHeading right={<span className="text-xs text-ink-300">{runs.length}</span>}>
        all runs
      </SectionHeading>
      {runs.length === 0 ? (
        <div className="text-xs text-ink-300">no runs yet</div>
      ) : (
        <div className="overflow-x-auto rounded border border-ink-700 bg-ink-800">
          <table className="w-full text-xs font-mono">
            <thead className="text-ink-300">
              <tr className="border-b border-ink-700">
                <th className="text-left px-3 py-2">status</th>
                <th className="text-left px-3 py-2">mode</th>
                <th className="text-left px-3 py-2">id</th>
                <th className="text-left px-3 py-2">started</th>
                <th className="text-right px-3 py-2">cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-ink-700 last:border-b-0 hover:bg-ink-700/30">
                  <td className="px-3 py-1.5">
                    <RunStatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-1.5 text-ink-300">{r.mode}</td>
                  <td className="px-3 py-1.5">
                    <a
                      href={`/runs/${encodeURIComponent(r.id)}`}
                      className="text-blue-300 hover:text-blue-200"
                    >
                      {r.id}
                    </a>
                  </td>
                  <td className="px-3 py-1.5 text-ink-300">
                    {fmtAbsoluteTs(r.created_at)}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {fmtUsd(r.total_cost_usd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type RecentDetailQuery = ReturnType<typeof useQueries<unknown[]>>[number];

function RecentRunsDetailSection({
  runIds,
  details,
}: {
  runIds: string[];
  details: RecentDetailQuery[];
}) {
  if (runIds.length === 0) return null;
  return (
    <section>
      <SectionHeading
        right={<span className="text-xs text-ink-300">{runIds.length}</span>}
      >
        recent runs
      </SectionHeading>
      <div className="space-y-3">
        {runIds.map((id, i) => {
          const q = details[i];
          return <RecentRunCard key={id} runId={id} query={q} />;
        })}
      </div>
    </section>
  );
}

function RecentRunCard({
  runId,
  query,
}: {
  runId: string;
  query: RecentDetailQuery | undefined;
}) {
  if (!query || query.isLoading) {
    return (
      <div className="rounded border border-ink-700 bg-ink-800 p-3 text-xs text-ink-300">
        loading {runId}…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="rounded border border-ink-700 bg-ink-800 p-3 text-xs text-rose-300">
        failed to load {runId}:{" "}
        {query.error instanceof Error ? query.error.message : "error"}
      </div>
    );
  }
  // RunDetail shape: { run, stages, findings_counts }. We typed the
  // useQueries return as unknown, narrow inline.
  const data = query.data as {
    run: Run;
    stages: import("../types.js").DisplayStage[];
    findings_counts: import("../types.js").RunDetail["findings_counts"];
  };
  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <RunStatusBadge status={data.run.status} />
          <span className="text-xs text-ink-300 font-mono">{data.run.mode}</span>
          <a
            href={`/runs/${encodeURIComponent(runId)}`}
            className="text-xs text-blue-300 hover:text-blue-200 font-mono truncate"
          >
            {runId}
          </a>
        </div>
        <div className="text-[11px] text-ink-300 font-mono">
          {fmtAbsoluteTs(data.run.created_at)} · {fmtUsd(data.run.total_cost_usd)}
        </div>
      </div>
      <StageTimeline stages={data.stages} />
      <FindingsCounts totals={data.findings_counts} />
    </div>
  );
}

function FindingsLedgerSection({
  entries,
  loading,
}: {
  entries: LedgerEntry[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <section>
        <SectionHeading>findings ledger</SectionHeading>
        <div className="text-xs text-ink-300">loading…</div>
      </section>
    );
  }
  return (
    <section>
      <SectionHeading
        right={<span className="text-xs text-ink-300">{entries.length}</span>}
      >
        findings ledger
      </SectionHeading>
      {entries.length === 0 ? (
        <div className="text-xs text-ink-300">no recurring findings yet</div>
      ) : (
        <ul className="divide-y divide-ink-700 rounded border border-ink-700 bg-ink-800">
          {entries.map((e) => (
            <li
              key={e.fingerprint}
              className="px-3 py-2 flex flex-col sm:flex-row sm:items-center gap-2"
            >
              <div className="flex items-center gap-2 shrink-0">
                <SeverityBadge severity={e.severity} />
                <span className="text-xs font-mono text-ink-300">
                  {e.critic}
                </span>
              </div>
              <div className="flex-1 min-w-0 text-sm">{e.title}</div>
              <div className="text-[11px] text-ink-300 font-mono">
                {e.runCount} runs · {e.occurrenceCount} hits
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProfileSection({
  profileMd,
  profileJson,
}: {
  profileMd: string | null;
  profileJson: ProfileData | null;
}) {
  if (!profileMd && !profileJson) {
    return (
      <section>
        <SectionHeading>repo profile</SectionHeading>
        <div className="text-xs text-ink-300">
          no profile — run <code className="bg-ink-900 px-1 rounded">mill onboard</code>{" "}
          to generate one.
        </div>
      </section>
    );
  }
  return (
    <section>
      <SectionHeading>repo profile</SectionHeading>
      <div className="rounded border border-ink-700 bg-ink-800 p-3 space-y-3">
        {profileJson ? <ProfileStructured profile={profileJson} /> : null}
        {profileMd ? <MarkdownProse source={profileMd} /> : null}
      </div>
    </section>
  );
}

function ProfileStructured({ profile }: { profile: ProfileData }) {
  const cmdEntries = Object.entries(profile.commands).filter(
    ([, v]) => v != null && v.length > 0,
  );
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pb-2 border-b border-ink-700">
      <KV label="stack" value={profile.stack || "—"} />
      <KV label="generated" value={fmtAbsoluteTs(parseIsoDate(profile.generatedAt))} />
      {cmdEntries.length > 0 ? (
        <div className="sm:col-span-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-300">
            commands
          </div>
          <ul className="mt-0.5 space-y-0.5 font-mono">
            {cmdEntries.map(([k, v]) => (
              <li key={k} className="text-ink-100">
                <span className="text-ink-300">{k}:</span> {v}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {profile.doNotTouch.length > 0 ? (
        <div className="sm:col-span-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-300">
            do not touch
          </div>
          <ul className="mt-0.5 space-y-0.5 font-mono">
            {profile.doNotTouch.map((p) => (
              <li key={p} className="text-ink-100">
                {p}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-300">
        {label}
      </div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}

function parseIsoDate(s: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function DecisionsSection({ source }: { source: string | null }) {
  return (
    <section>
      <SectionHeading>decisions log</SectionHeading>
      {source ? (
        <div className="rounded border border-ink-700 bg-ink-800 p-3">
          <MarkdownProse source={source} />
        </div>
      ) : (
        <div className="text-xs text-ink-300">no decisions logged</div>
      )}
    </section>
  );
}

function JournalSection({ source }: { source: string | null }) {
  return (
    <section>
      <SectionHeading>activity journal</SectionHeading>
      {source ? (
        <div className="rounded border border-ink-700 bg-ink-800 p-3">
          <MarkdownProse source={source} />
        </div>
      ) : (
        <div className="text-xs text-ink-300">no completed runs yet</div>
      )}
    </section>
  );
}

function StitchSection({ stitch }: { stitch: StitchProjectRef | null }) {
  if (!stitch) return null;
  return (
    <section>
      <SectionHeading>stitch project</SectionHeading>
      <div className="rounded border border-ink-700 bg-ink-800 p-3 text-xs space-y-1">
        <div>
          <a
            href={stitch.projectUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-300 hover:text-blue-200 font-mono break-all"
          >
            {stitch.projectUrl}
          </a>
        </div>
        <div className="text-ink-300 font-mono">
          last run: {stitch.lastRunId} · updated {stitch.updatedAt}
        </div>
      </div>
    </section>
  );
}
