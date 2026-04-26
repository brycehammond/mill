import { SeverityBadge } from "./StatusBadge.js";
import type { Severity } from "../types.js";

// Compact severity-count strip for a single run. Returns null when
// there are no findings so callers don't need to guard.

export function FindingsCounts({
  totals,
}: {
  totals: Record<Severity, number> & { total: number };
}) {
  if (totals.total === 0) return null;
  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-3 flex items-center gap-3 flex-wrap">
      {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((sev) =>
        totals[sev] > 0 ? (
          <div key={sev} className="flex items-center gap-1.5">
            <SeverityBadge severity={sev} />
            <span className="font-mono text-sm">{totals[sev]}</span>
          </div>
        ) : null,
      )}
      <span className="text-xs text-ink-300 ml-auto">{totals.total} total</span>
    </div>
  );
}
