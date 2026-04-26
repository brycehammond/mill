import { fmtDurationMs, fmtUsd } from "./format.js";
import { StageStatusGlyph } from "./StatusBadge.js";
import type { DisplayStage } from "../types.js";

// Stage list for a single run. Reused by the run detail screen and the
// project report's recent-runs section, so it lives in components/.

export function StageTimeline({ stages }: { stages: DisplayStage[] }) {
  if (stages.length === 0) return null;
  return (
    <ol className="rounded border border-ink-700 bg-ink-800 divide-y divide-ink-700">
      {stages.map((s, idx) => {
        const dur =
          s.started_at && s.finished_at ? s.finished_at - s.started_at : null;
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
  );
}
