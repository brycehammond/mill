import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import { fmtAbsoluteTs, fmtRelativeTs, fmtUsd } from "../components/format.js";
import { RunStatusBadge, SeverityBadge } from "../components/StatusBadge.js";
import { ErrorState, Loading, SectionHeading } from "./dashboard.js";
import { useRoute } from "../router.js";
import type {
  Clarifications,
  CreateRunResponse,
  RunStatus,
} from "../types.js";

export function ProjectScreen({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  const runs = useQuery({
    queryKey: ["runs", projectId],
    queryFn: () => api.listRuns({ project: projectId, limit: 200 }),
    refetchInterval: 5_000,
  });
  const findings = useQuery({
    queryKey: ["project-findings", projectId],
    queryFn: () => api.projectFindings(projectId),
  });

  if (project.isLoading) return <Loading />;
  if (project.isError) return <ErrorState error={project.error} />;
  const p = project.data!;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-lg">{p.name}</h1>
        <div className="text-xs text-ink-300 font-mono break-all">{p.root_path}</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-xs">
          <Stat label="today" value={fmtUsd(p.cost_today_usd)} />
          <Stat label="MTD" value={fmtUsd(p.cost_mtd_usd)} />
          <Stat label="in flight" value={String(p.in_flight_runs)} />
          <Stat label="registered" value={fmtRelativeTs(p.added_at)} />
        </div>
      </header>

      <NewRunForm projectId={projectId} />

      <section>
        <SectionHeading>runs</SectionHeading>
        {runs.isLoading ? (
          <Loading />
        ) : runs.isError ? (
          <ErrorState error={runs.error} />
        ) : (
          <RunsList runs={runs.data ?? []} />
        )}
      </section>

      <section>
        <SectionHeading>findings ledger</SectionHeading>
        {findings.isLoading ? (
          <div className="text-xs text-ink-300">loading…</div>
        ) : findings.isError ? (
          <ErrorState error={findings.error} />
        ) : findings.data!.entries.length === 0 ? (
          <div className="text-xs text-ink-300">no recurring findings yet</div>
        ) : (
          <ul className="divide-y divide-ink-700 rounded border border-ink-700 bg-ink-800">
            {findings.data!.entries.map((e) => (
              <li
                key={e.fingerprint}
                className="px-3 py-2 flex flex-col sm:flex-row sm:items-center gap-2"
              >
                <div className="flex items-center gap-2 shrink-0">
                  <SeverityBadge severity={e.severity} />
                  <span className="text-xs font-mono text-ink-300">{e.critic}</span>
                </div>
                <div className="flex-1 min-w-0 text-sm">{e.title}</div>
                <div className="text-[11px] text-ink-300 font-mono">
                  {e.runCount} runs
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-ink-700 bg-ink-800 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-300">
        {label}
      </div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}

function NewRunForm({ projectId }: { projectId: string }) {
  const [requirement, setRequirement] = useState("");
  const [mode, setMode] = useState<"new" | "edit">("edit");
  const [allDefaults, setAllDefaults] = useState(false);
  const [pending, setPending] = useState<CreateRunResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  const { push } = useRoute();

  const create = useMutation({
    mutationFn: () =>
      api.createRun(projectId, {
        requirement,
        mode,
        all_defaults: allDefaults,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["runs", projectId] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      if (res.status === "running") {
        push(`/runs/${encodeURIComponent(res.run_id)}`);
        return;
      }
      // awaiting_clarification — surface the question form inline.
      setPending(res);
      const initial: Record<string, string> = {};
      for (const q of res.clarifications?.questions ?? []) {
        initial[q.id] = q.default ?? "";
      }
      setAnswers(initial);
    },
  });

  const submit = useMutation({
    mutationFn: () => {
      if (!pending) throw new Error("no pending run");
      return api.submitClarifications(pending.run_id, answers);
    },
    onSuccess: () => {
      const id = pending!.run_id;
      qc.invalidateQueries({ queryKey: ["runs", projectId] });
      push(`/runs/${encodeURIComponent(id)}`);
    },
  });

  if (pending && pending.clarifications) {
    return (
      <ClarificationForm
        clarifications={pending.clarifications}
        answers={answers}
        setAnswers={setAnswers}
        onSubmit={() => submit.mutate()}
        onCancel={() => {
          setPending(null);
          setAnswers({});
        }}
        submitting={submit.isPending}
        error={submit.error}
      />
    );
  }

  return (
    <section className="rounded border border-ink-700 bg-ink-800 p-3 space-y-3">
      <SectionHeading>new run</SectionHeading>
      <textarea
        value={requirement}
        onChange={(e) => setRequirement(e.target.value)}
        placeholder="what should mill build?"
        className="w-full rounded bg-ink-900 border border-ink-700 px-2 py-2 text-sm focus:outline-none focus:border-ink-500 font-mono min-h-[6rem]"
      />
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">mode</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "new" | "edit")}
            className="bg-ink-900 border border-ink-700 rounded px-1.5 py-0.5 font-mono"
          >
            <option value="edit">edit</option>
            <option value="new">new</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={allDefaults}
            onChange={(e) => setAllDefaults(e.target.checked)}
            className="accent-ink-100"
          />
          <span>accept all defaults (skip clarifications)</span>
        </label>
        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={create.isPending || !requirement.trim()}
          className="ml-auto rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-ink-700 disabled:text-ink-300 px-3 py-1 font-mono text-xs"
        >
          {create.isPending ? "starting…" : "start run"}
        </button>
      </div>
      {create.isError ? (
        <div className="text-xs text-rose-300">
          {create.error instanceof ApiError
            ? create.error.message
            : "failed to start run"}
        </div>
      ) : null}
    </section>
  );
}

function ClarificationForm({
  clarifications,
  answers,
  setAnswers,
  onSubmit,
  onCancel,
  submitting,
  error,
}: {
  clarifications: Clarifications;
  answers: Record<string, string>;
  setAnswers: (v: Record<string, string>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
  error: unknown;
}) {
  return (
    <section className="rounded border border-amber-800 bg-amber-950/30 p-3 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-mono text-sm">clarifications needed</h2>
        <span className="text-xs text-ink-300">
          kind: {clarifications.kind}
        </span>
      </div>
      <ul className="space-y-3">
        {clarifications.questions.map((q) => (
          <li key={q.id} className="space-y-1">
            <label className="text-sm block">
              <span className="font-mono">{q.question}</span>
              {q.why ? (
                <span className="block text-[11px] text-ink-300 mt-0.5">
                  {q.why}
                </span>
              ) : null}
            </label>
            <input
              value={answers[q.id] ?? ""}
              onChange={(e) =>
                setAnswers({ ...answers, [q.id]: e.target.value })
              }
              placeholder={q.default ? `default: ${q.default}` : ""}
              className="w-full rounded bg-ink-900 border border-ink-700 px-2 py-1 text-sm font-mono"
            />
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-ink-300 hover:text-ink-100 px-2 py-1"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-ink-700 px-3 py-1 font-mono text-xs"
        >
          {submitting ? "submitting…" : "submit answers"}
        </button>
      </div>
      {error ? (
        <div className="text-xs text-rose-300">
          {error instanceof Error ? error.message : "failed to submit"}
        </div>
      ) : null}
    </section>
  );
}

function RunsList({
  runs,
}: {
  runs: import("../types.js").Run[];
}) {
  if (runs.length === 0) {
    return <div className="text-xs text-ink-300">no runs yet</div>;
  }
  return (
    <ul className="divide-y divide-ink-700 rounded border border-ink-700 bg-ink-800">
      {runs.map((r) => (
        <li key={r.id}>
          <a
            href={`/runs/${encodeURIComponent(r.id)}`}
            className="block px-3 py-2 hover:bg-ink-700/50"
          >
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <RunStatusBadge status={r.status as RunStatus} />
                <span className="text-xs font-mono text-ink-300 shrink-0">
                  {r.mode}
                </span>
                <span className="font-mono text-xs truncate">{r.id}</span>
              </div>
              <div className="text-[11px] text-ink-300 font-mono">
                {fmtAbsoluteTs(r.created_at)} · {fmtUsd(r.total_cost_usd)}
              </div>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
