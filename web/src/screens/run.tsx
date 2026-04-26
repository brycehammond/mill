import { useMemo, useRef, useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api.js";
import {
  fmtAbsoluteTs,
  fmtDurationMs,
  fmtRelativeTs,
  fmtUsd,
} from "../components/format.js";
import {
  RunStatusBadge,
  SeverityBadge,
  StageStatusGlyph,
} from "../components/StatusBadge.js";
import { useRunEventStream } from "../sse.js";
import { ErrorState, Loading, SectionHeading } from "./dashboard.js";
import type { DisplayStage, Run, RunDetail, WireEvent } from "../types.js";

// Run view: live SSE feed + stage timeline + findings + cost panel.
// The detail query is the source of truth for stages/totals; SSE
// drives the activity feed. We refetch detail on a slow cadence so
// stage transitions reflect even before a final SSE frame lands.

export function RunScreen({ runId }: { runId: string }) {
  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.getRun(runId),
    refetchInterval: 4_000,
  });

  if (detail.isLoading) return <Loading />;
  if (detail.isError) return <ErrorState error={detail.error} />;
  const d = detail.data!;

  return (
    <div className="space-y-6">
      <RunHeader runId={runId} run={d.run} stages={d.stages} />
      <ApprovalBanner runId={runId} run={d.run} stages={d.stages} />
      <BudgetBanner runId={runId} run={d.run} />
      <StageTimeline stages={d.stages} />
      <ActivityFeedPanel runId={runId} />
      <FindingsPanel runId={runId} totals={d.findings_counts} />
      <CostPanel stages={d.stages} runTotal={d.run.total_cost_usd} />
    </div>
  );
}

function RunHeader({
  runId,
  run,
  stages,
}: {
  runId: string;
  run: Run;
  stages: DisplayStage[];
}) {
  const qc = useQueryClient();
  const kill = useMutation({
    mutationFn: () => api.killRun(runId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["run", runId] }),
  });
  const lastFinished = stages.reduce<number | null>((acc, s) => {
    if (s.finished_at == null) return acc;
    if (acc == null || s.finished_at > acc) return s.finished_at;
    return acc;
  }, null);
  const elapsedMs =
    run.status === "running" || run.status === "queued"
      ? Date.now() - run.created_at
      : (lastFinished ?? Date.now()) - run.created_at;
  const live =
    run.status === "running" ||
    run.status === "queued" ||
    run.status === "awaiting_clarification";

  const [confirming, setConfirming] = useState(false);

  return (
    <header className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <RunStatusBadge status={run.status} />
          <span className="text-xs font-mono text-ink-300">{run.mode}</span>
          <span className="font-mono text-sm truncate">{run.id}</span>
          {live ? (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 mill-breathe"
              aria-hidden="true"
              title="live"
            />
          ) : null}
        </div>
        {live && run.status !== "awaiting_clarification" ? (
          confirming ? (
            <div className="flex items-center gap-2 text-xs">
              <span>kill this run?</span>
              <button
                type="button"
                onClick={() => kill.mutate()}
                disabled={kill.isPending}
                className="rounded bg-rose-700 hover:bg-rose-600 disabled:bg-ink-700 px-2 py-1 font-mono"
              >
                {kill.isPending ? "killing…" : "yes, kill"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-ink-300 hover:text-ink-100 px-2 py-1"
              >
                cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded border border-rose-800 hover:border-rose-600 text-rose-200 px-2 py-1 font-mono text-xs"
            >
              kill
            </button>
          )
        ) : null}
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <DT label="started" value={fmtAbsoluteTs(run.created_at)} />
        <DT label="elapsed" value={fmtDurationMs(elapsedMs)} />
        <DT label="cost" value={fmtUsd(run.total_cost_usd)} />
        <DT label="kind" value={run.kind ?? "—"} />
      </dl>
    </header>
  );
}

function ApprovalBanner({
  runId,
  run,
  stages,
}: {
  runId: string;
  run: Run;
  stages: DisplayStage[];
}) {
  const qc = useQueryClient();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [approveNote, setApproveNote] = useState("");

  const approve = useMutation({
    mutationFn: (note: string) => api.approveRun(runId, note || undefined),
    onSuccess: () => {
      setApproveNote("");
      qc.invalidateQueries({ queryKey: ["run", runId] });
    },
  });
  const reject = useMutation({
    mutationFn: (note: string) => api.rejectRun(runId, note),
    onSuccess: () => {
      setRejectOpen(false);
      setRejectNote("");
      qc.invalidateQueries({ queryKey: ["run", runId] });
    },
  });

  if (run.status !== "awaiting_approval") return null;
  const gateStage = run.awaiting_approval_at_stage ?? "next stage";
  // The gated stage's previous stage produced the artifact under review.
  // Surface the most recent completed stage's artifact_path as the
  // approval summary anchor — matches the lean from plan Q9.
  const lastCompleted = [...stages]
    .reverse()
    .find((s) => s.status === "completed" && s.artifact_path);

  return (
    <section className="rounded border border-violet-700 bg-violet-950/40 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-mono text-sm text-violet-100">
            awaiting approval
          </h2>
          <p className="text-xs text-violet-200/80 mt-0.5">
            paused before <span className="font-mono">{gateStage}</span> —
            review the previous stage&rsquo;s output, then approve to continue
            or reject to stop.
          </p>
        </div>
      </div>

      {lastCompleted ? (
        <ApprovalSummary stage={lastCompleted} />
      ) : (
        <div className="text-xs text-ink-300 italic">
          no completed stage artifact found.
        </div>
      )}

      {!rejectOpen ? (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <input
            type="text"
            value={approveNote}
            onChange={(e) => setApproveNote(e.target.value)}
            placeholder="optional note for the audit trail…"
            className="flex-1 rounded bg-ink-900 border border-ink-700 px-2 py-1 text-xs font-mono"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => approve.mutate(approveNote)}
              disabled={approve.isPending}
              className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-ink-700 px-3 py-1 font-mono text-xs"
            >
              {approve.isPending ? "approving…" : "approve"}
            </button>
            <button
              type="button"
              onClick={() => setRejectOpen(true)}
              disabled={approve.isPending || reject.isPending}
              className="rounded bg-rose-700 hover:bg-rose-600 disabled:bg-ink-700 px-3 py-1 font-mono text-xs"
            >
              reject
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-xs text-violet-200">
            reason (required for the audit trail)
          </label>
          <textarea
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            className="w-full rounded bg-ink-900 border border-ink-700 px-2 py-1.5 text-xs font-mono min-h-[4rem]"
            placeholder="why is this wrong?"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setRejectOpen(false);
                setRejectNote("");
              }}
              className="text-xs text-ink-300 hover:text-ink-100 px-2 py-1"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={() => reject.mutate(rejectNote.trim())}
              disabled={reject.isPending || rejectNote.trim().length === 0}
              className="rounded bg-rose-700 hover:bg-rose-600 disabled:bg-ink-700 px-3 py-1 font-mono text-xs"
            >
              {reject.isPending ? "rejecting…" : "confirm reject"}
            </button>
          </div>
        </div>
      )}

      {(approve.error || reject.error) && (
        <div className="text-xs text-rose-300">
          {(approve.error ?? reject.error) instanceof ApiError
            ? (approve.error ?? reject.error)!.message
            : "request failed"}
        </div>
      )}
    </section>
  );
}

function ApprovalSummary({ stage }: { stage: DisplayStage }) {
  return (
    <details className="rounded border border-ink-700 bg-ink-900/60 p-2 text-xs">
      <summary className="cursor-pointer font-mono text-ink-200">
        {stage.displayName} — {stage.artifact_path ?? "no artifact"}
      </summary>
      <div className="mt-2 text-ink-300 leading-relaxed">
        the artifact is on disk at the path above. open it from a terminal
        on the daemon host to read the full output, or use{" "}
        <code className="bg-ink-700 px-1 rounded font-mono">
          mill logs {stage.run_id}
        </code>{" "}
        to inspect events from this stage.
      </div>
    </details>
  );
}

function BudgetBanner({ runId, run }: { runId: string; run: Run }) {
  const qc = useQueryClient();
  const [budgetMsg, setBudgetMsg] = useState<string | null>(null);
  const resume = useMutation({
    mutationFn: () => api.resumeRun(runId),
    onSuccess: () => {
      setBudgetMsg(null);
      qc.invalidateQueries({ queryKey: ["run", runId] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 402) {
        const body = err.body as
          | { error?: string; currentSpend?: number; budget?: number }
          | undefined;
        const cur = body?.currentSpend;
        const bud = body?.budget;
        if (cur != null && bud != null) {
          setBudgetMsg(
            `still over budget — ${fmtUsd(cur)} of ${fmtUsd(bud)} used this month.`,
          );
        } else {
          setBudgetMsg(body?.error ?? "still over budget.");
        }
      } else {
        setBudgetMsg(err instanceof Error ? err.message : "resume failed");
      }
    },
  });

  if (run.status !== "paused_budget") return null;
  return (
    <section className="rounded border border-amber-700 bg-amber-950/40 p-4 space-y-3">
      <div>
        <h2 className="font-mono text-sm text-amber-100">
          paused — monthly budget reached
        </h2>
        <p className="text-xs text-amber-200/80 mt-0.5">
          this run will not start its next stage until the project budget is
          raised or a new month begins. resume tries again — if the project is
          still over its cap, the daemon refuses with the current spend.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => resume.mutate()}
          disabled={resume.isPending}
          className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-ink-700 px-3 py-1 font-mono text-xs"
        >
          {resume.isPending ? "resuming…" : "resume"}
        </button>
        {budgetMsg ? (
          <div className="text-xs text-amber-200 font-mono">{budgetMsg}</div>
        ) : null}
      </div>
    </section>
  );
}

function DT({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-ink-700 bg-ink-800 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wide text-ink-300">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}

function StageTimeline({ stages }: { stages: DisplayStage[] }) {
  if (stages.length === 0) {
    return null;
  }
  return (
    <section>
      <SectionHeading>stages</SectionHeading>
      <ol className="rounded border border-ink-700 bg-ink-800 divide-y divide-ink-700">
        {stages.map((s, idx) => {
          const dur =
            s.started_at && s.finished_at
              ? s.finished_at - s.started_at
              : null;
          return (
            <li
              key={`${s.name}-${s.iteration ?? "n"}-${idx}`}
              className="px-3 py-2 flex items-center gap-3 text-sm"
            >
              <StageStatusGlyph status={s.status} />
              <span className="font-mono w-32 sm:w-44 truncate">
                {s.displayName}
              </span>
              <span className="text-xs text-ink-300 font-mono w-16 shrink-0">
                {fmtUsd(s.cost_usd)}
              </span>
              <span className="text-xs text-ink-300 font-mono w-16 shrink-0">
                {fmtDurationMs(dur)}
              </span>
              <span className="text-xs text-ink-300 truncate">
                {s.error ? `error: ${s.error}` : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ActivityFeedPanel({ runId }: { runId: string }) {
  const sse = useRunEventStream(runId);
  const [paused, setPaused] = useState(false);
  const [verbose, setVerbose] = useState(false);
  const [pinned, setPinned] = useState<WireEvent[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const events = paused ? pinned : sse.events;

  // When unpausing, drop the pin and rejoin the live tail.
  useEffect(() => {
    if (!paused) setPinned([]);
  }, [paused]);

  // Auto-scroll to the bottom on new frames unless the user has
  // scrolled up. We measure that with a tolerance — the feed is
  // monospace, line heights are stable.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom && !paused) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events, paused]);

  return (
    <section>
      <SectionHeading
        right={
          <div className="flex items-center gap-2 text-[11px] text-ink-300">
            <ConnectionDot status={sse.status} />
            <button
              type="button"
              onClick={() => setVerbose((v) => !v)}
              className="hover:text-ink-100"
            >
              {verbose ? "compact" : "verbose"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!paused) setPinned(sse.events.slice());
                setPaused((p) => !p);
              }}
              className="hover:text-ink-100"
            >
              {paused ? "resume" : "pause"}
            </button>
          </div>
        }
      >
        activity
      </SectionHeading>
      <div
        ref={containerRef}
        onMouseEnter={() => setPaused((p) => p || false)}
        className="rounded border border-ink-700 bg-ink-900 font-mono text-[11px] leading-snug p-2 max-h-[420px] overflow-y-auto"
      >
        {events.length === 0 ? (
          <div className="text-ink-300 italic px-1 py-3">
            {sse.status === "open" ? "no events yet" : "connecting…"}
          </div>
        ) : (
          events.map((ev) => <FeedRow key={ev.id} ev={ev} verbose={verbose} />)
        )}
      </div>
    </section>
  );
}

function FeedRow({ ev, verbose }: { ev: WireEvent; verbose: boolean }) {
  const ts = new Date(ev.ts).toLocaleTimeString();
  const summary = useMemo(() => summarizePayload(ev), [ev]);
  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-ink-300 shrink-0">{ts}</span>
      <span className="text-blue-300 shrink-0 w-20 truncate" title={ev.stage}>
        {ev.stage}
      </span>
      <span className="text-emerald-300 shrink-0 w-28 truncate" title={ev.kind}>
        {ev.kind}
      </span>
      <span className="text-ink-100 break-words min-w-0 flex-1">
        {verbose ? (
          <pre className="whitespace-pre-wrap break-all m-0">
            {JSON.stringify(ev.payload, null, 2)}
          </pre>
        ) : (
          summary
        )}
      </span>
    </div>
  );
}

function summarizePayload(ev: WireEvent): string {
  if (ev.payload == null) return "";
  if (typeof ev.payload === "string") return ev.payload;
  if (typeof ev.payload !== "object") return String(ev.payload);
  // Pick readable fields the orchestrator emits.
  const p = ev.payload as Record<string, unknown>;
  for (const key of [
    "message",
    "text",
    "summary",
    "title",
    "error",
    "session_id",
    "iteration",
  ]) {
    if (typeof p[key] === "string" || typeof p[key] === "number") {
      return String(p[key]);
    }
  }
  // Fallback: top-level keys, no values.
  const keys = Object.keys(p);
  if (keys.length === 0) return "";
  return `{${keys.slice(0, 4).join(", ")}}`;
}

function ConnectionDot({ status }: { status: "connecting" | "open" | "closed" | "error" }) {
  const cls =
    status === "open"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400"
        : status === "error"
          ? "bg-rose-400"
          : "bg-ink-300";
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`}
        aria-hidden="true"
      />
      {status}
    </span>
  );
}

function FindingsPanel({
  runId,
  totals,
}: {
  runId: string;
  totals: RunDetail["findings_counts"];
}) {
  // Counts come from the run detail. The list endpoint isn't on the
  // server yet for per-run findings (only ledger entries), so we keep
  // this simple — show counts plus a hint.
  void runId;
  if (totals.total === 0) {
    return null;
  }
  return (
    <section>
      <SectionHeading>findings</SectionHeading>
      <div className="rounded border border-ink-700 bg-ink-800 p-3 flex items-center gap-3 flex-wrap">
        {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((sev) =>
          totals[sev] > 0 ? (
            <div key={sev} className="flex items-center gap-1.5">
              <SeverityBadge severity={sev} />
              <span className="font-mono text-sm">{totals[sev]}</span>
            </div>
          ) : null,
        )}
        <span className="text-xs text-ink-300 ml-auto">
          {totals.total} total
        </span>
      </div>
    </section>
  );
}

function CostPanel({
  stages,
  runTotal,
}: {
  stages: DisplayStage[];
  runTotal: number;
}) {
  if (stages.length === 0 && runTotal === 0) return null;
  return (
    <section>
      <SectionHeading right={<span className="font-mono text-sm">{fmtUsd(runTotal)}</span>}>
        cost
      </SectionHeading>
      <ol className="rounded border border-ink-700 bg-ink-800 divide-y divide-ink-700 font-mono text-xs">
        {stages.map((s, idx) => (
          <li
            key={`cost-${s.name}-${s.iteration ?? "n"}-${idx}`}
            className="px-3 py-1.5 flex items-baseline justify-between"
          >
            <span className="truncate">{s.displayName}</span>
            <span className="text-ink-300">
              {fmtUsd(s.cost_usd)}
              {s.finished_at ? "" : ` · ${fmtRelativeTs(s.finished_at ?? null)}`}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
