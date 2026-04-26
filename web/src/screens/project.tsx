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
  StageName,
  WebhookRow,
} from "../types.js";

// Gateable stages — taken from the plan (item 4): the natural seams
// between intake/clarify (no gate value), spec → design, design →
// implement, etc. We expose every "real" stage so the user can gate
// wherever they want; ordering matches STAGE_ORDER.
const GATEABLE_STAGES: StageName[] = [
  "spec",
  "design",
  "spec2tests",
  "implement",
  "verify",
  "deliver",
];

const WEBHOOK_EVENTS = [
  "run.completed",
  "run.failed",
  "run.killed",
  "finding.high",
  "approval.required",
  "budget.warning_80",
  "budget.exceeded",
];

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

      <SettingsPanel projectId={projectId} />

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

function SettingsPanel({ projectId }: { projectId: string }) {
  return (
    <section className="space-y-4">
      <SectionHeading>settings</SectionHeading>
      <GatesEditor projectId={projectId} />
      <WebhooksEditor projectId={projectId} />
    </section>
  );
}

function GatesEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const gates = useQuery({
    queryKey: ["project-gates", projectId],
    queryFn: () => api.getProjectGates(projectId),
  });
  const [draft, setDraft] = useState<StageName[] | null>(null);
  const current = draft ?? gates.data?.stages ?? [];

  const save = useMutation({
    mutationFn: () => api.setProjectGates(projectId, current),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["project-gates", projectId] });
    },
  });
  const clear = useMutation({
    mutationFn: () => api.clearProjectGates(projectId),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["project-gates", projectId] });
    },
  });

  if (gates.isLoading) {
    return <PanelShell title="approval gates" body={<div className="text-xs text-ink-300">loading…</div>} />;
  }
  if (gates.isError) {
    return (
      <PanelShell
        title="approval gates"
        body={
          <div className="text-xs text-rose-300">
            {gates.error instanceof Error ? gates.error.message : "error"}
          </div>
        }
      />
    );
  }

  const toggle = (stage: StageName) => {
    const next = current.includes(stage)
      ? current.filter((s) => s !== stage)
      : [...current, stage];
    setDraft(next);
  };

  const dirty = draft !== null;
  const hasGates = (gates.data?.stages ?? []).length > 0;

  return (
    <PanelShell
      title="approval gates"
      hint="pause runs after the selected stage(s) and require approval before continuing."
      body={
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {GATEABLE_STAGES.map((stage) => {
              const active = current.includes(stage);
              return (
                <button
                  key={stage}
                  type="button"
                  onClick={() => toggle(stage)}
                  className={`rounded px-2 py-1 font-mono text-xs border ${
                    active
                      ? "bg-violet-900/60 border-violet-600 text-violet-100"
                      : "bg-ink-900 border-ink-700 text-ink-300 hover:border-ink-500"
                  }`}
                >
                  {stage}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={!dirty || save.isPending}
              className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-ink-700 disabled:text-ink-300 px-3 py-1 font-mono text-xs"
            >
              {save.isPending ? "saving…" : "save"}
            </button>
            {dirty ? (
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="text-xs text-ink-300 hover:text-ink-100 px-2 py-1"
              >
                cancel
              </button>
            ) : null}
            {hasGates ? (
              <button
                type="button"
                onClick={() => clear.mutate()}
                disabled={clear.isPending}
                className="ml-auto text-xs text-rose-300 hover:text-rose-100 px-2 py-1 font-mono"
              >
                {clear.isPending ? "clearing…" : "clear all"}
              </button>
            ) : null}
          </div>
          {save.error || clear.error ? (
            <div className="text-xs text-rose-300">
              {(save.error ?? clear.error) instanceof Error
                ? (save.error ?? clear.error)!.message
                : "save failed"}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function WebhooksEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["project-webhooks", projectId],
    queryFn: () => api.listProjectWebhooks(projectId),
  });

  const [adding, setAdding] = useState(false);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["project-webhooks", projectId] }),
  });

  if (list.isLoading) {
    return <PanelShell title="webhooks" body={<div className="text-xs text-ink-300">loading…</div>} />;
  }
  if (list.isError) {
    return (
      <PanelShell
        title="webhooks"
        body={
          <div className="text-xs text-rose-300">
            {list.error instanceof Error ? list.error.message : "error"}
          </div>
        }
      />
    );
  }

  const hooks = list.data?.webhooks ?? [];

  return (
    <PanelShell
      title="webhooks"
      hint="POSTs JSON to each URL when a matching event fires. signature header X-Mill-Signature uses HMAC-SHA256 of the body with the configured secret."
      body={
        <div className="space-y-3">
          {hooks.length === 0 ? (
            <div className="text-xs text-ink-300">none</div>
          ) : (
            <ul className="rounded border border-ink-700 bg-ink-900 divide-y divide-ink-700">
              {hooks.map((w) => (
                <WebhookRowView
                  key={w.id}
                  hook={w}
                  onDelete={() => remove.mutate(w.id)}
                  deleting={remove.isPending}
                />
              ))}
            </ul>
          )}

          {adding ? (
            <NewWebhookForm
              projectId={projectId}
              onDone={() => setAdding(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded border border-ink-700 hover:border-ink-500 px-3 py-1 font-mono text-xs"
            >
              + add webhook
            </button>
          )}

          {remove.error ? (
            <div className="text-xs text-rose-300">
              {remove.error instanceof Error
                ? remove.error.message
                : "delete failed"}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function WebhookRowView({
  hook,
  onDelete,
  deleting,
}: {
  hook: WebhookRow;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <li className="px-3 py-2 flex flex-col sm:flex-row sm:items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs break-all">{hook.url}</div>
        <div className="text-[11px] text-ink-300 mt-0.5 font-mono">
          {hook.events.join(", ") || "(no events)"}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px] font-mono shrink-0">
        <span
          className={
            hook.enabled
              ? "text-emerald-300"
              : "text-rose-300"
          }
        >
          {hook.enabled ? "enabled" : "disabled"}
        </span>
        {hook.consecutive_failures > 0 ? (
          <span className="text-amber-300">
            {hook.consecutive_failures} consecutive fails
          </span>
        ) : null}
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="text-rose-300 hover:text-rose-100 px-2 py-0.5"
        >
          delete
        </button>
      </div>
    </li>
  );
}

function NewWebhookForm({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>(["run.completed"]);

  const create = useMutation({
    mutationFn: () =>
      api.createProjectWebhook(projectId, { url, events, secret }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-webhooks", projectId] });
      onDone();
    },
  });

  const toggle = (ev: string) => {
    setEvents((cur) =>
      cur.includes(ev) ? cur.filter((e) => e !== ev) : [...cur, ev],
    );
  };

  const valid =
    url.trim().length > 0 && secret.length > 0 && events.length > 0;

  return (
    <div className="rounded border border-ink-700 bg-ink-900 p-3 space-y-3">
      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-300">url</span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.example.com/mill"
          className="w-full rounded bg-ink-900 border border-ink-700 px-2 py-1 text-xs font-mono"
        />
      </label>
      <div className="space-y-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-300 block">
          events
        </span>
        <div className="flex flex-wrap gap-2">
          {WEBHOOK_EVENTS.map((ev) => {
            const active = events.includes(ev);
            return (
              <button
                key={ev}
                type="button"
                onClick={() => toggle(ev)}
                className={`rounded px-2 py-0.5 font-mono text-[11px] border ${
                  active
                    ? "bg-blue-900/60 border-blue-600 text-blue-100"
                    : "bg-ink-900 border-ink-700 text-ink-300 hover:border-ink-500"
                }`}
              >
                {ev}
              </button>
            );
          })}
        </div>
      </div>
      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-300">
          secret (required)
        </span>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="HMAC signing key"
          className="w-full rounded bg-ink-900 border border-ink-700 px-2 py-1 text-xs font-mono"
        />
      </label>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="text-xs text-ink-300 hover:text-ink-100 px-2 py-1"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={!valid || create.isPending}
          className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-ink-700 disabled:text-ink-300 px-3 py-1 font-mono text-xs"
        >
          {create.isPending ? "creating…" : "create"}
        </button>
      </div>
      {create.error ? (
        <div className="text-xs text-rose-300">
          {create.error instanceof ApiError
            ? create.error.message
            : "create failed"}
        </div>
      ) : null}
    </div>
  );
}

function PanelShell({
  title,
  body,
  hint,
}: {
  title: string;
  body: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-3 space-y-2">
      <div>
        <h3 className="font-mono text-sm text-ink-100">{title}</h3>
        {hint ? <p className="text-[11px] text-ink-300 mt-0.5">{hint}</p> : null}
      </div>
      {body}
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
