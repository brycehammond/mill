import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtUsd, fmtRelativeTs } from "../components/format.js";
import { RunStatusBadge, SeverityBadge } from "../components/StatusBadge.js";
import type { Dashboard, DashboardProject, Run } from "../types.js";

// Cross-project rollup. The dashboard endpoint aggregates per-project
// costs; we kick off a parallel runs-by-status fetch so the pending
// approvals badge and the per-project paused/warning chips reflect
// state even before the backend extends `Dashboard` to include them.

export function DashboardScreen() {
  const dash = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.dashboard(),
  });
  // Parallel queries: any awaiting_approval / paused_budget runs across
  // the daemon. Used to derive the badge count and per-project chips
  // when the dashboard payload doesn't carry them natively.
  const awaiting = useQuery({
    queryKey: ["runs", "awaiting_approval"],
    queryFn: () =>
      api.listRuns({ status: "awaiting_approval", limit: 200 }),
    refetchInterval: 8_000,
  });
  const paused = useQuery({
    queryKey: ["runs", "paused_budget"],
    queryFn: () => api.listRuns({ status: "paused_budget", limit: 200 }),
    refetchInterval: 8_000,
  });

  if (dash.isLoading) return <Loading />;
  if (dash.isError) return <ErrorState error={dash.error} />;
  const data = dash.data!;
  const awaitingRuns = awaiting.data ?? [];
  const pausedRuns = paused.data ?? [];
  const pendingTotal = data.pending_approvals ?? awaitingRuns.length;

  return (
    <div className="space-y-6">
      <Hero
        costToday={data.cost_today_usd}
        costMtd={data.cost_mtd_usd}
        runsInFlight={data.runs_in_flight}
        projectCount={data.project_count}
      />
      <ApprovalsBadge count={pendingTotal} runs={awaitingRuns} />
      <ProjectGrid
        projects={data.projects}
        awaitingRuns={awaitingRuns}
        pausedRuns={pausedRuns}
      />
      <RecurringFindings entries={data.top_recurring_findings} />
    </div>
  );
}

function ApprovalsBadge({ count, runs }: { count: number; runs: Run[] }) {
  if (count === 0) return null;
  return (
    <a
      href="#approvals"
      className="block rounded border border-violet-700 bg-violet-950/40 px-3 py-2 text-sm text-violet-100 hover:bg-violet-950/60"
      onClick={(e) => {
        e.preventDefault();
        const target = document.getElementById("approvals");
        target?.scrollIntoView({ behavior: "smooth" });
      }}
    >
      <span className="font-mono">{count} pending approval{count === 1 ? "" : "s"}</span>
      <span className="text-xs text-violet-200/80 ml-2">
        runs paused at a stage gate.
      </span>
      {runs.length > 0 ? (
        <ul
          id="approvals"
          className="mt-2 divide-y divide-violet-900/60 rounded border border-violet-900/60 bg-ink-900/40"
        >
          {runs.slice(0, 10).map((r) => (
            <li key={r.id}>
              <a
                href={`/runs/${encodeURIComponent(r.id)}`}
                className="block px-3 py-1.5 hover:bg-violet-900/30 text-xs font-mono flex items-center justify-between gap-2"
              >
                <span className="truncate">{r.id}</span>
                <span className="text-violet-300 shrink-0">
                  {r.awaiting_approval_at_stage ?? "—"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </a>
  );
}

function Hero({
  costToday,
  costMtd,
  runsInFlight,
  projectCount,
}: {
  costToday: number;
  costMtd: number;
  runsInFlight: number;
  projectCount: number;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Stat label="cost today" value={fmtUsd(costToday)} />
      <Stat label="cost month-to-date" value={fmtUsd(costMtd)} />
      <Stat
        label="runs in flight"
        value={String(runsInFlight)}
        accent={runsInFlight > 0 ? "live" : "idle"}
      />
      <Stat label="projects" value={String(projectCount)} />
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "live" | "idle";
}) {
  return (
    <div className="rounded border border-ink-700 bg-ink-800 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-ink-300 flex items-center gap-1">
        {accent === "live" ? (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 mill-breathe"
            aria-hidden="true"
          />
        ) : null}
        {label}
      </div>
      <div className="font-mono text-lg sm:text-xl mt-1">{value}</div>
    </div>
  );
}

type BudgetState = "ok" | "warning_80" | "paused";

function deriveBudgetState(
  p: DashboardProject,
  pausedRuns: Run[],
): BudgetState {
  if (p.budget_state === "paused" || p.budget_state === "warning_80" || p.budget_state === "ok") {
    return p.budget_state;
  }
  // Fallback: any paused_budget run for this project → red.
  const projectPaused = pausedRuns.some((r) => r.project_id === p.id);
  if (projectPaused) return "paused";
  // Yellow: cost_mtd >= 80% of monthly_budget when both are known.
  if (
    p.monthly_budget_usd != null &&
    p.monthly_budget_usd > 0 &&
    p.cost_mtd_usd / p.monthly_budget_usd >= 0.8
  ) {
    return "warning_80";
  }
  return "ok";
}

function BudgetChip({ state }: { state: BudgetState }) {
  if (state === "ok") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-900/60 text-emerald-200 px-1.5 py-0.5 text-[10px] font-mono">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
        budget ok
      </span>
    );
  }
  if (state === "warning_80") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-900/60 text-amber-200 px-1.5 py-0.5 text-[10px] font-mono">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
        80%
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-rose-900/60 text-rose-200 px-1.5 py-0.5 text-[10px] font-mono">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-400" />
      paused
    </span>
  );
}

function ProjectGrid({
  projects,
  awaitingRuns,
  pausedRuns,
}: {
  projects: Dashboard["projects"];
  awaitingRuns: Run[];
  pausedRuns: Run[];
}) {
  if (projects.length === 0) {
    return (
      <EmptyState
        title="no projects yet"
        body={
          <>
            register a project from the CLI:{" "}
            <code className="bg-ink-700 px-1 py-0.5 rounded font-mono">
              mill project add /path/to/repo
            </code>
          </>
        }
      />
    );
  }
  return (
    <section>
      <SectionHeading>projects</SectionHeading>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {projects.map((p) => {
          const state = deriveBudgetState(p, pausedRuns);
          const pendingHere = awaitingRuns.filter(
            (r) => r.project_id === p.id,
          ).length;
          return (
            <a
              key={p.id}
              href={`/projects/${encodeURIComponent(p.id)}`}
              className="rounded border border-ink-700 bg-ink-800 hover:border-ink-500 transition-colors p-3 block"
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="font-mono text-base truncate">{p.name}</div>
                {p.last_run_status ? (
                  <RunStatusBadge status={p.last_run_status} />
                ) : null}
              </div>
              <div className="text-[11px] text-ink-300 truncate font-mono mt-0.5">
                {p.root_path}
              </div>
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                <BudgetChip state={state} />
                {pendingHere > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded bg-violet-900/60 text-violet-200 px-1.5 py-0.5 text-[10px] font-mono">
                    {pendingHere} pending
                  </span>
                ) : null}
              </div>
              <dl className="grid grid-cols-3 gap-2 mt-3 text-xs">
                <div>
                  <dt className="text-ink-300">today</dt>
                  <dd className="font-mono">{fmtUsd(p.cost_today_usd)}</dd>
                </div>
                <div>
                  <dt className="text-ink-300">in flight</dt>
                  <dd className="font-mono">{p.in_flight_runs}</dd>
                </div>
                <div>
                  <dt className="text-ink-300">last delivery</dt>
                  <dd className="font-mono">{fmtRelativeTs(p.last_delivery_ts)}</dd>
                </div>
              </dl>
            </a>
          );
        })}
      </div>
    </section>
  );
}

function RecurringFindings({
  entries,
}: {
  entries: import("../types.js").LedgerEntry[];
}) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <section>
      <SectionHeading>recurring findings</SectionHeading>
      <ul className="divide-y divide-ink-700 rounded border border-ink-700 bg-ink-800">
        {entries.map((e) => (
          <li
            key={e.fingerprint}
            className="px-3 py-2 flex items-start sm:items-center gap-3 flex-col sm:flex-row"
          >
            <div className="flex items-center gap-2 shrink-0">
              <SeverityBadge severity={e.severity} />
              <span className="text-xs font-mono text-ink-300">{e.critic}</span>
            </div>
            <div className="flex-1 min-w-0 text-sm">{e.title}</div>
            <div className="text-xs text-ink-300 font-mono shrink-0">
              {e.runCount} runs · last seen {fmtRelativeTs(e.lastSeen)}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SectionHeading({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between mb-2">
      <h2 className="text-xs uppercase tracking-wide text-ink-300">{children}</h2>
      {right}
    </div>
  );
}

export function Loading() {
  return <div className="text-sm text-ink-300 py-8 text-center">loading…</div>;
}

export function ErrorState({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded border border-rose-700 bg-rose-950/40 px-3 py-2 text-sm">
      <div className="font-mono text-rose-200">error</div>
      <div className="text-rose-100 mt-1 break-words">{msg}</div>
      <div className="text-xs text-ink-300 mt-2">
        is the daemon running?{" "}
        <code className="bg-ink-700 px-1 rounded font-mono">mill daemon start</code>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
}: {
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="rounded border border-dashed border-ink-700 bg-ink-800/50 px-4 py-6 text-center">
      <div className="font-mono text-sm">{title}</div>
      <div className="text-xs text-ink-300 mt-2">{body}</div>
    </div>
  );
}
