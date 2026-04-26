// Live stage-status display for inline pipeline runs (`mill new`, `mill
// run`). Polls the SQLite stages table on a short interval and prints a
// one-liner whenever a stage transitions:
//
//   ▸ spec
//   ✓ spec · 4.2s · $0.23
//   ▸ design
//   ✓ design · 12s · $0.71
//   ⊘ spec2tests · skipped
//   ▸ implement
//   ✗ implement · 1m02s · $5.47
//
// Pipeline events stream into the events table from `claude-cli.ts`,
// but for top-level "where am I in the pipeline" feedback, the stages
// table is the right granularity — one row per stage, with status,
// started_at, finished_at, cost_usd. The full `mill tail -f <id>`
// command renders the underlying event stream when the user wants
// detail.
//
// Implementation notes:
//  - The ticker is a `setInterval` polling at intervalMs. Polling, not
//    eventing, because the pipeline writes via SqliteStateStore from
//    the same process and we don't have an EventEmitter on the store.
//    1s polling is plenty for stage transitions (which fire on the
//    order of seconds to minutes).
//  - `stop()` runs one final tick before clearing the interval so a
//    completion that happened between polls still prints.
//  - We track per-stage *first-seen-running* and *first-seen-terminal*
//    transitions so each stage prints `▸` once and `✓`/`✗`/`⊘` once,
//    even if the row's status flickers (it shouldn't, but defensively).
//  - Output goes to stdout via process.stdout.write — caller controls
//    when console output happens around it.

import type {
  StageRow,
  StageStatus,
  StateStore,
} from "../core/index.js";

export type Color = (s: string) => string;

export interface ProgressFormatters {
  fmtDurationMs: (ms: number) => string;
  fmtCost: (n: number) => string;
  // Color helpers are passed in so the ticker stays portable to a
  // future non-tty consumer (web UI, log aggregator). Defaults are
  // identity (no color) — caller wires in chalk-style helpers.
  green?: Color;
  red?: Color;
  yellow?: Color;
  dim?: Color;
}

export interface ProgressTickerOpts extends ProgressFormatters {
  store: StateStore;
  runId: string;
  intervalMs?: number;
  // Defaults to process.stdout.write for production; tests inject a
  // capture function.
  write?: (s: string) => void;
}

export interface ProgressTickerHandle {
  stop(): void;
  // Exposed for tests; production callers don't need this.
  tickNow(): void;
}

const TERMINAL: ReadonlySet<StageStatus> = new Set([
  "completed",
  "failed",
  "skipped",
]);

const identity: Color = (s) => s;

export function startStageProgressTicker(
  opts: ProgressTickerOpts,
): ProgressTickerHandle {
  const {
    store,
    runId,
    intervalMs = 1000,
    fmtDurationMs,
    fmtCost,
    green = identity,
    red = identity,
    yellow = identity,
    dim = identity,
    write = (s) => process.stdout.write(s),
  } = opts;

  // Per-stage state. Each stage prints `▸` once on first sight of
  // running, then a terminal marker once on first sight of terminal
  // status. Skipped stages skip the `▸` entirely.
  const announcedRunning = new Set<string>();
  const announcedTerminal = new Set<string>();

  const renderTransition = (s: StageRow): string | null => {
    const isTerminal = TERMINAL.has(s.status);

    if (s.status === "running" && !announcedRunning.has(s.name)) {
      announcedRunning.add(s.name);
      return `${dim("▸")} ${s.name}\n`;
    }

    if (isTerminal && !announcedTerminal.has(s.name)) {
      announcedTerminal.add(s.name);
      // Skipped never had a "▸" — render compactly.
      if (s.status === "skipped") {
        return `${dim("⊘")} ${s.name} ${dim("·")} ${dim("skipped")}\n`;
      }
      const start = s.started_at ?? Date.now();
      const end = s.finished_at ?? Date.now();
      const elapsed = Math.max(0, end - start);
      const marker = s.status === "completed" ? green("✓") : red("✗");
      const errSuffix =
        s.status === "failed" && s.error
          ? ` ${dim("·")} ${yellow(truncate(s.error, 80))}`
          : "";
      return (
        `${marker} ${s.name} ${dim("·")} ${fmtDurationMs(elapsed)} ${dim("·")} ${fmtCost(s.cost_usd)}${errSuffix}\n`
      );
    }

    return null;
  };

  const tick = () => {
    let stages: StageRow[];
    try {
      stages = store.listStages(runId);
    } catch {
      return;
    }
    // Sort by started_at to print in the order stages actually ran.
    // Pending stages (no started_at) sort to the end and are ignored
    // anyway since they have no transition to announce.
    stages.sort((a, b) => (a.started_at ?? Infinity) - (b.started_at ?? Infinity));
    for (const s of stages) {
      const line = renderTransition(s);
      if (line) write(line);
    }
  };

  const handle = setInterval(tick, intervalMs);
  // Don't keep the event loop alive purely for the ticker.
  if (typeof handle.unref === "function") handle.unref();

  return {
    tickNow: tick,
    stop: () => {
      clearInterval(handle);
      // Final flush: a completion that happened between polls still
      // gets its terminal marker.
      tick();
    },
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
