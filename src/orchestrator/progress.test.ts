import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type {
  DisplayStageRow,
  FindingRow,
  RunRow,
  RunStatus,
  StageRow,
  StateStore,
} from "../core/index.js";
import { startStageProgressTicker } from "./progress.js";

const fmtDurationMs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const fmtCost = (n: number): string => `$${n.toFixed(2)}`;

interface FakeStore {
  store: StateStore;
  set(stages: StageRow[]): void;
  setDisplay(rows: DisplayStageRow[]): void;
  setRun(status: RunStatus): void;
  setFindings(rows: FindingRow[]): void;
}

function fakeStore(): FakeStore {
  let stages: StageRow[] = [];
  let displayOverride: DisplayStageRow[] | null = null;
  let runStatus: RunStatus = "running";
  let findings: FindingRow[] = [];
  const store = {
    listStages: () => stages,
    listDisplayStages: () => {
      const rows = displayOverride ?? stages.map(stageToDisplay);
      // Mirror SqliteStateStore.listDisplayStages: chronological, with
      // iteration tiebreaker for rows that share started_at.
      return [...rows].sort((a, b) => {
        const sa = a.started_at ?? Infinity;
        const sb = b.started_at ?? Infinity;
        if (sa !== sb) return sa - sb;
        return (a.iteration ?? 0) - (b.iteration ?? 0);
      });
    },
    getRun: (): RunRow => ({
      id: "r1",
      project_id: null,
      status: runStatus,
      kind: "ui",
      mode: "new",
      created_at: 0,
      requirement_path: "/x",
      spec_path: null,
      test_command: null,
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cache_read_tokens: 0,
      total_output_tokens: 0,
    }),
    listFindings: (
      _runId: string,
      opts?: { iteration?: number },
    ): FindingRow[] => {
      if (opts?.iteration !== undefined) {
        return findings.filter((f) => f.iteration === opts.iteration);
      }
      return findings;
    },
  } as unknown as StateStore;
  return {
    store,
    set: (next) => {
      stages = next;
      displayOverride = null;
    },
    setDisplay: (rows) => {
      displayOverride = rows;
    },
    setRun: (status) => {
      runStatus = status;
    },
    setFindings: (rows) => {
      findings = rows;
    },
  };
}

function stageToDisplay(s: StageRow): DisplayStageRow {
  return {
    run_id: s.run_id,
    name: s.name,
    displayName: s.name,
    iteration: null,
    status: s.status,
    started_at: s.started_at,
    finished_at: s.finished_at,
    cost_usd: s.cost_usd,
    input_tokens: s.input_tokens,
    cache_creation_tokens: s.cache_creation_tokens,
    cache_read_tokens: s.cache_read_tokens,
    output_tokens: s.output_tokens,
    session_id: s.session_id,
    artifact_path: s.artifact_path,
    error: s.error,
  };
}

const finding = (patch: Partial<FindingRow> = {}): FindingRow => ({
  id: 1,
  run_id: "r1",
  iteration: 1,
  critic: "security",
  severity: "HIGH",
  title: "x",
  detail_path: "/x",
  fingerprint: "security|HIGH|x",
  ...patch,
});

const stage = (
  name: string,
  patch: Partial<StageRow> = {},
): StageRow => ({
  run_id: "r1",
  name: name as StageRow["name"],
  status: "pending",
  started_at: null,
  finished_at: null,
  cost_usd: 0,
  input_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  output_tokens: 0,
  session_id: null,
  artifact_path: null,
  error: null,
  ...patch,
});

const display = (
  name: string,
  iteration: number | null,
  patch: Partial<DisplayStageRow> = {},
): DisplayStageRow => ({
  run_id: "r1",
  name: name as DisplayStageRow["name"],
  displayName: iteration !== null ? `${name} #${iteration}` : name,
  iteration,
  status: "pending",
  started_at: null,
  finished_at: null,
  cost_usd: 0,
  input_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  output_tokens: 0,
  session_id: null,
  artifact_path: null,
  error: null,
  ...patch,
});

function newCapture(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    write: (s) => {
      // Strip the trailing newline for simpler assertions.
      lines.push(s.replace(/\n$/, ""));
    },
  };
}

describe("startStageProgressTicker", () => {
  it("emits ▸ on first running and a terminal marker once on completion", () => {
    const fake = fakeStore();
    const cap = newCapture();
    const ticker = startStageProgressTicker({
      store: fake.store,
      runId: "r1",
      fmtDurationMs,
      fmtCost,
      write: cap.write,
      // Use a huge interval so the auto-tick never fires; we drive it
      // manually via tickNow() for deterministic assertions.
      intervalMs: 9_999_999,
    });

    fake.set([stage("spec", { status: "running", started_at: 1000 })]);
    ticker.tickNow();
    fake.set([
      stage("spec", {
        status: "completed",
        started_at: 1000,
        finished_at: 4200,
        cost_usd: 0.23,
      }),
    ]);
    ticker.tickNow();
    // A redundant tick must not duplicate the markers.
    ticker.tickNow();

    ticker.stop();
    assert.equal(cap.lines.length, 2, cap.lines.join("\n"));
    assert.match(cap.lines[0]!, /▸ spec/);
    assert.match(cap.lines[1]!, /✓ spec/);
    assert.match(cap.lines[1]!, /3\.2s/);
    assert.match(cap.lines[1]!, /\$0\.23/);
  });

  it("renders failed stages with ✗ and the error suffix", () => {
    const fake = fakeStore();
    const cap = newCapture();
    const ticker = startStageProgressTicker({
      store: fake.store,
      runId: "r1",
      fmtDurationMs,
      fmtCost,
      write: cap.write,
      intervalMs: 9_999_999,
    });

    fake.set([
      stage("spec", {
        status: "failed",
        started_at: 1000,
        finished_at: 1500,
        cost_usd: 0.05,
        error: "output-too-short: validation failed after retry",
      }),
    ]);
    ticker.tickNow();
    ticker.stop();
    const line = cap.lines[cap.lines.length - 1]!;
    assert.match(line, /✗ spec/);
    assert.match(line, /output-too-short/);
  });

  it("renders skipped stages compactly (no ▸ first)", () => {
    const fake = fakeStore();
    const cap = newCapture();
    const ticker = startStageProgressTicker({
      store: fake.store,
      runId: "r1",
      fmtDurationMs,
      fmtCost,
      write: cap.write,
      intervalMs: 9_999_999,
    });

    fake.set([stage("spec2tests", { status: "skipped" })]);
    ticker.tickNow();
    ticker.stop();
    const lines = cap.lines.filter((l) => l.includes("spec2tests"));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /⊘ spec2tests/);
    assert.match(lines[0]!, /skipped/);
  });

  it("stop() flushes a transition that happened between polls", () => {
    const fake = fakeStore();
    const cap = newCapture();
    const ticker = startStageProgressTicker({
      store: fake.store,
      runId: "r1",
      fmtDurationMs,
      fmtCost,
      write: cap.write,
      intervalMs: 9_999_999,
    });

    fake.set([stage("spec", { status: "running", started_at: 1000 })]);
    ticker.tickNow();
    // Stage completes between the last poll and shutdown.
    fake.set([
      stage("spec", {
        status: "completed",
        started_at: 1000,
        finished_at: 1100,
        cost_usd: 0.01,
      }),
    ]);
    ticker.stop();

    assert.equal(cap.lines.length, 2);
    assert.match(cap.lines[1]!, /✓ spec/);
  });

  it("prints multiple stages in started_at order", () => {
    const fake = fakeStore();
    const cap = newCapture();
    const ticker = startStageProgressTicker({
      store: fake.store,
      runId: "r1",
      fmtDurationMs,
      fmtCost,
      write: cap.write,
      intervalMs: 9_999_999,
    });

    // listStages might return in any order; we sort by started_at.
    fake.set([
      stage("design", { status: "running", started_at: 2000 }),
      stage("spec", { status: "completed", started_at: 1000, finished_at: 1500, cost_usd: 0.1 }),
    ]);
    ticker.tickNow();
    ticker.stop();

    // First line should reference spec (started_at=1000), second design (2000).
    assert.match(cap.lines[0]!, /spec/);
    assert.match(cap.lines[1]!, /design/);
  });

  it("loud-fails deliver when the run shipped with unresolved HIGH+ findings", () => {
    const fake = fakeStore();
    fake.setRun("failed");
    fake.setFindings([
      finding({ id: 1, iteration: 2, severity: "HIGH", title: "a" }),
      finding({ id: 2, iteration: 2, severity: "CRITICAL", title: "b" }),
      // An iteration-1 finding should NOT be counted (it's resolved
      // unless still present at the highest iteration).
      finding({ id: 3, iteration: 1, severity: "HIGH", title: "old" }),
    ]);
    const cap = newCapture();
    const ticker = startStageProgressTicker({
      store: fake.store,
      runId: "r1",
      fmtDurationMs,
      fmtCost,
      write: cap.write,
      intervalMs: 9_999_999,
    });

    fake.set([
      stage("deliver", {
        status: "completed",
        started_at: 1000,
        finished_at: 1400,
        cost_usd: 0,
      }),
    ]);
    ticker.tickNow();
    ticker.stop();

    const line = cap.lines[cap.lines.length - 1]!;
    assert.match(line, /⚠ deliver/);
    assert.match(line, /2 unresolved HIGH\+ findings/);
    assert.doesNotMatch(line, /✓/);
  });

  it("uses singular noun when exactly one HIGH+ finding remains", () => {
    const fake = fakeStore();
    fake.setRun("failed");
    fake.setFindings([finding({ iteration: 1, severity: "HIGH" })]);
    const cap = newCapture();
    const ticker = startStageProgressTicker({
      store: fake.store,
      runId: "r1",
      fmtDurationMs,
      fmtCost,
      write: cap.write,
      intervalMs: 9_999_999,
    });
    fake.set([
      stage("deliver", {
        status: "completed",
        started_at: 1000,
        finished_at: 1400,
      }),
    ]);
    ticker.tickNow();
    ticker.stop();
    const line = cap.lines[cap.lines.length - 1]!;
    assert.match(line, /1 unresolved HIGH\+ finding\b/);
    assert.doesNotMatch(line, /findings/);
  });

  it("renders one ▸/✓ pair per iteration when listDisplayStages expands the loop", () => {
    const fake = fakeStore();
    fake.setFindings([
      finding({ id: 1, iteration: 1, severity: "HIGH", title: "a" }),
      finding({ id: 2, iteration: 1, severity: "HIGH", title: "b" }),
      finding({ id: 3, iteration: 2, severity: "HIGH", title: "a" }),
    ]);
    const cap = newCapture();
    const ticker = startStageProgressTicker({
      store: fake.store,
      runId: "r1",
      fmtDurationMs,
      fmtCost,
      write: cap.write,
      intervalMs: 9_999_999,
    });

    // First tick: implement #1 running.
    fake.setDisplay([
      display("implement", 1, { status: "running", started_at: 1000 }),
    ]);
    ticker.tickNow();
    // implement #1 completes; review #1 starts.
    fake.setDisplay([
      display("implement", 1, {
        status: "completed",
        started_at: 1000,
        finished_at: 1500,
        cost_usd: 0.5,
      }),
      display("review", 1, { status: "running", started_at: 1600 }),
    ]);
    ticker.tickNow();
    // review #1 completes (with 2 HIGH+ findings); implement #2 starts.
    fake.setDisplay([
      display("implement", 1, {
        status: "completed",
        started_at: 1000,
        finished_at: 1500,
        cost_usd: 0.5,
      }),
      display("review", 1, {
        status: "completed",
        started_at: 1600,
        finished_at: 2000,
        cost_usd: 0.7,
      }),
      display("implement", 2, { status: "running", started_at: 2100 }),
    ]);
    ticker.tickNow();
    ticker.stop();

    // Each iteration gets its own ▸ and terminal marker — review #1's
    // line carries the HIGH+ count so the user knows why implement #2
    // is queueing up.
    assert.match(cap.lines[0]!, /▸ implement #1/);
    assert.match(cap.lines[1]!, /✓ implement #1/);
    assert.match(cap.lines[2]!, /▸ review #1/);
    const reviewDone = cap.lines.find((l) => l.includes("✓ review #1"));
    assert.ok(reviewDone, cap.lines.join("\n"));
    assert.match(reviewDone!, /2 HIGH\+ findings/);
    const implTwo = cap.lines.find((l) => l.includes("▸ implement #2"));
    assert.ok(implTwo, cap.lines.join("\n"));
  });

  it("renders ✓ deliver normally when the run shipped clean (status=running or completed)", () => {
    const fake = fakeStore();
    // run.status stays default "running" — pipeline summary will flip
    // it to "completed" *after* deliver finishes its stage row, so
    // during the deliver-completed tick the run row is still "running".
    // The loud-fail path only fires when status === "failed".
    const cap = newCapture();
    const ticker = startStageProgressTicker({
      store: fake.store,
      runId: "r1",
      fmtDurationMs,
      fmtCost,
      write: cap.write,
      intervalMs: 9_999_999,
    });
    fake.set([
      stage("deliver", {
        status: "completed",
        started_at: 1000,
        finished_at: 1100,
        cost_usd: 0,
      }),
    ]);
    ticker.tickNow();
    ticker.stop();
    const line = cap.lines[cap.lines.length - 1]!;
    assert.match(line, /✓ deliver/);
    assert.doesNotMatch(line, /⚠/);
    assert.doesNotMatch(line, /unresolved/);
  });
});
