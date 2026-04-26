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

import {
  atLeast,
  type DisplayStageRow,
  type StageStatus,
  type StateStore,
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

  // Per-row state, keyed on `displayName` so each iteration of
  // `implement #1`, `implement #2`, ... gets its own ▸/✓ pair. Stages
  // without iteration suffix dedupe just on the stage name.
  const announcedRunning = new Set<string>();
  const announcedTerminal = new Set<string>();

  const renderTransition = (s: DisplayStageRow): string | null => {
    const isTerminal = TERMINAL.has(s.status);
    const key = s.displayName;

    if (s.status === "running" && !announcedRunning.has(key)) {
      announcedRunning.add(key);
      return `${dim("▸")} ${key}\n`;
    }

    if (isTerminal && !announcedTerminal.has(key)) {
      announcedTerminal.add(key);
      // Skipped never had a "▸" — render compactly.
      if (s.status === "skipped") {
        return `${dim("⊘")} ${key} ${dim("·")} ${dim("skipped")}\n`;
      }
      const start = s.started_at ?? Date.now();
      const end = s.finished_at ?? Date.now();
      const elapsed = Math.max(0, end - start);

      // Special case: `deliver` always finishes its own stage row as
      // `completed` (the stage executed fine), but the *run* row gets
      // flipped to `failed` when there are unresolved HIGH+ findings
      // — the "delivered with open issues" path. A plain ✓ would lie
      // about the pipeline outcome. Surface it here so the user
      // doesn't have to wait for the final summary to learn the run
      // didn't ship cleanly.
      if (s.name === "deliver" && s.status === "completed") {
        const unresolved = countUnresolvedHighIfFailed(store, runId);
        if (unresolved !== null) {
          const noun = unresolved === 1 ? "finding" : "findings";
          return (
            `${yellow("⚠")} ${key} ${dim("·")} ${fmtDurationMs(elapsed)} ${dim("·")} ${fmtCost(s.cost_usd)} ${dim("·")} ${yellow(`${unresolved} unresolved HIGH+ ${noun}`)}\n`
          );
        }
      }

      // Per-iteration HIGH+ count for review rows — same shape as the
      // status table's "note" column, surfaced live so the user sees
      // why an extra implement iteration is queueing up.
      let iterNote = "";
      if (s.name === "review" && s.iteration !== null && s.status === "completed") {
        const n = countHighFindingsForIteration(store, runId, s.iteration);
        if (n > 0) {
          iterNote = ` ${dim("·")} ${yellow(`${n} HIGH+ ${n === 1 ? "finding" : "findings"}`)}`;
        }
      }

      const marker = s.status === "completed" ? green("✓") : red("✗");
      const errSuffix =
        s.status === "failed" && s.error
          ? ` ${dim("·")} ${yellow(truncate(s.error, 80))}`
          : "";
      return (
        `${marker} ${key} ${dim("·")} ${fmtDurationMs(elapsed)} ${dim("·")} ${fmtCost(s.cost_usd)}${iterNote}${errSuffix}\n`
      );
    }

    return null;
  };

  const tick = () => {
    let stages: DisplayStageRow[];
    try {
      stages = store.listDisplayStages(runId);
    } catch {
      return;
    }
    // listDisplayStages already sorts by started_at + iteration; keep
    // its order so per-iteration rows print in chronological sequence.
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

// Returns the count of unresolved HIGH+ findings if (and only if) the
// run's row says it shipped failed. Returns null when the run shipped
// clean (the caller renders the normal ✓). Null on any DB read error
// — defensive: a transient query failure shouldn't degrade an
// otherwise correct progress display.
// HIGH+ findings from the given review iteration only. Used inline by
// the ticker so the user sees, per iteration, how many HIGH-or-higher
// issues were found. Returns 0 on any DB read error — defensive: a
// transient query failure shouldn't degrade the otherwise correct ✓.
function countHighFindingsForIteration(
  store: StateStore,
  runId: string,
  iteration: number,
): number {
  try {
    return store
      .listFindings(runId, { iteration })
      .filter((f) => atLeast(f.severity, "HIGH")).length;
  } catch {
    return 0;
  }
}

function countUnresolvedHighIfFailed(
  store: StateStore,
  runId: string,
): number | null {
  let runStatus: string | undefined;
  try {
    runStatus = store.getRun(runId)?.status;
  } catch {
    return null;
  }
  if (runStatus !== "failed") return null;
  let findings: ReturnType<StateStore["listFindings"]>;
  try {
    findings = store.listFindings(runId);
  } catch {
    return 0;
  }
  if (findings.length === 0) return 0;
  let maxIter = 0;
  for (const f of findings) if (f.iteration > maxIter) maxIter = f.iteration;
  return findings.filter(
    (f) => f.iteration === maxIter && atLeast(f.severity, "HIGH"),
  ).length;
}
