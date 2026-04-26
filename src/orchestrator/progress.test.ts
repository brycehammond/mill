import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { StageRow, StateStore } from "../core/index.js";
import { startStageProgressTicker } from "./progress.js";

const fmtDurationMs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const fmtCost = (n: number): string => `$${n.toFixed(2)}`;

interface FakeStore {
  store: StateStore;
  set(stages: StageRow[]): void;
}

function fakeStore(): FakeStore {
  let stages: StageRow[] = [];
  const store = {
    listStages: () => stages,
  } as unknown as StateStore;
  return {
    store,
    set: (next) => {
      stages = next;
    },
  };
}

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
});
