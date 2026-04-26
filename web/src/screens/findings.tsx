import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtRelativeTs } from "../components/format.js";
import { SeverityBadge } from "../components/StatusBadge.js";
import { ErrorState, Loading, SectionHeading } from "./dashboard.js";
import type { LedgerEntry } from "../types.js";

export function FindingsScreen() {
  const [includeSuppressed, setIncludeSuppressed] = useState(false);
  const ledger = useQuery({
    queryKey: ["findings", includeSuppressed],
    queryFn: () =>
      api.findings({ include_suppressed: includeSuppressed, min_runs: 1 }),
  });
  const suppressed = useQuery({
    queryKey: ["suppressed"],
    queryFn: () => api.listSuppressed(),
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });

  const projectName = (id: string | null): string => {
    if (!id) return "—";
    const p = projects.data?.find((x) => x.id === id);
    return p?.name ?? id;
  };
  // The ledger endpoint doesn't surface project ids per-fingerprint,
  // so we just pass `projects` along and let the row render show the
  // count for now. (The per-project view is a separate screen.)
  void projectName;

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <h1 className="font-mono text-lg">findings ledger</h1>
        <label className="text-xs flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={includeSuppressed}
            onChange={(e) => setIncludeSuppressed(e.target.checked)}
            className="accent-ink-100"
          />
          show suppressed
        </label>
      </header>

      <section>
        <SectionHeading>recurring</SectionHeading>
        {ledger.isLoading ? (
          <Loading />
        ) : ledger.isError ? (
          <ErrorState error={ledger.error} />
        ) : ledger.data!.entries.length === 0 ? (
          <div className="text-xs text-ink-300">no findings yet</div>
        ) : (
          <LedgerList entries={ledger.data!.entries} />
        )}
      </section>

      <section>
        <SectionHeading>suppressed</SectionHeading>
        {suppressed.isLoading ? (
          <div className="text-xs text-ink-300">loading…</div>
        ) : suppressed.isError ? (
          <ErrorState error={suppressed.error} />
        ) : suppressed.data!.entries.length === 0 ? (
          <div className="text-xs text-ink-300">none</div>
        ) : (
          <SuppressedList entries={suppressed.data!.entries} />
        )}
      </section>
    </div>
  );
}

function LedgerList({ entries }: { entries: LedgerEntry[] }) {
  const qc = useQueryClient();
  const suppress = useMutation({
    mutationFn: (fingerprint: string) => api.suppress(fingerprint),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["findings"] });
      qc.invalidateQueries({ queryKey: ["suppressed"] });
    },
  });
  return (
    <ul className="divide-y divide-ink-700 rounded border border-ink-700 bg-ink-800">
      {entries.map((e) => (
        <li
          key={e.fingerprint}
          className={`px-3 py-2 flex flex-col sm:flex-row sm:items-center gap-2 ${
            e.suppressed ? "opacity-50" : ""
          }`}
        >
          <div className="flex items-center gap-2 shrink-0">
            <SeverityBadge severity={e.severity} />
            <span className="text-xs font-mono text-ink-300">{e.critic}</span>
          </div>
          <div className="flex-1 min-w-0 text-sm">{e.title}</div>
          <div className="text-[11px] text-ink-300 font-mono shrink-0">
            {e.runCount} runs · {fmtRelativeTs(e.lastSeen)}
          </div>
          {!e.suppressed ? (
            <button
              type="button"
              onClick={() => suppress.mutate(e.fingerprint)}
              disabled={suppress.isPending}
              className="text-[11px] rounded border border-ink-700 hover:border-ink-500 px-1.5 py-0.5 font-mono"
            >
              suppress
            </button>
          ) : (
            <span className="text-[11px] font-mono text-ink-300">suppressed</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function SuppressedList({
  entries,
}: {
  entries: import("../types.js").SuppressedEntry[];
}) {
  const qc = useQueryClient();
  const unsuppress = useMutation({
    mutationFn: (fingerprint: string) => api.unsuppress(fingerprint),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["findings"] });
      qc.invalidateQueries({ queryKey: ["suppressed"] });
    },
  });
  return (
    <ul className="divide-y divide-ink-700 rounded border border-ink-700 bg-ink-800">
      {entries.map((e) => (
        <li
          key={e.fingerprint}
          className="px-3 py-2 flex flex-col sm:flex-row sm:items-center gap-2"
        >
          <div className="flex-1 min-w-0">
            <div className="font-mono text-xs text-ink-100 break-all">
              {e.fingerprint}
            </div>
            {e.note ? (
              <div className="text-[11px] text-ink-300 mt-0.5">{e.note}</div>
            ) : null}
          </div>
          <div className="text-[11px] text-ink-300 font-mono shrink-0">
            added {fmtRelativeTs(e.added_at)}
          </div>
          <button
            type="button"
            onClick={() => unsuppress.mutate(e.fingerprint)}
            disabled={unsuppress.isPending}
            className="text-[11px] rounded border border-ink-700 hover:border-ink-500 px-1.5 py-0.5 font-mono"
          >
            unsuppress
          </button>
        </li>
      ))}
    </ul>
  );
}
