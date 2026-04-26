import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SqliteStateStore } from "../core/store.sqlite.js";
import type { GlobalMillConfig } from "../orchestrator/config.js";
import type { RunContext } from "../core/index.js";
import { startRunLoop } from "./run-loop.js";

// Run-loop unit tests. We stub `pipeline` and `buildCtx` so the loop
// runs entirely in-memory; the only "real" thing is the SQLite store
// (`:memory:`). Each test queues N runs, asserts how many run
// concurrently, then verifies the loop drains cleanly on stop.

function makeConfig(maxConcurrentRuns: number): GlobalMillConfig {
  return {
    millHome: "/tmp/mill-home",
    dbPath: ":memory:",
    daemonHost: "127.0.0.1",
    daemonPort: 7333,
    maxConcurrentRuns,
    maxReviewIters: 3,
    timeoutSecPerRun: 60,
    timeoutSecPerStage: 30,
    timeoutSecPerStageOverrides: {},
    model: undefined,
    publicUrl: undefined,
  };
}

function fakeCtx(runId: string): RunContext {
  return {
    runId,
    projectId: "test",
    kind: null,
    mode: "new",
    paths: {} as never,
    store: {} as never,
    abortController: new AbortController(),
    costs: {} as never,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({} as never),
    },
    model: undefined,
    root: "/tmp",
    stateDir: "/tmp",
    stageTimeoutMs: 60_000,
    stageTimeoutsMs: {},
  };
}

describe("startRunLoop", () => {
  it("global cap bounds concurrent runs across projects", async () => {
    const store = new SqliteStateStore(":memory:");
    store.init();
    store.addProject({ id: "p1", name: "p1", root_path: "/tmp/p1" });
    store.addProject({ id: "p2", name: "p2", root_path: "/tmp/p2" });
    for (let i = 0; i < 4; i++) {
      const projectId = i < 2 ? "p1" : "p2";
      store.createRun({
        id: `r${i}`,
        project_id: projectId,
        status: "running",
        kind: null,
        created_at: i,
        requirement_path: "/x",
      });
    }

    let active = 0;
    let peak = 0;
    const releases: Array<{ runId: string; resolve: () => void }> = [];

    const loop = startRunLoop({
      store,
      config: makeConfig(2),
      pollIntervalMs: 5,
      logger: () => {},
      buildCtx: async ({ runId }) => fakeCtx(runId),
      pipeline: ({ runId }) => {
        active += 1;
        peak = Math.max(peak, active);
        return new Promise((resolve) => {
          releases.push({
            runId,
            resolve: () => {
              active -= 1;
              // The real pipeline marks the run completed; mirror that
              // so the loop doesn't immediately re-pick the same row.
              store.updateRun(runId, { status: "completed" });
              resolve(null);
            },
          });
        });
      },
    });

    // Wait for the loop to ramp up to the cap.
    await waitFor(() => loop.inFlight() === 2, 1000);
    assert.equal(loop.inFlight(), 2);
    assert.equal(peak, 2);

    // Release one — the next queued row should slot in, but never exceed cap.
    releases.shift()!.resolve();
    await waitFor(() => active === 2, 1000);
    assert.equal(peak, 2);

    // Drain the rest.
    while (releases.length > 0) {
      releases.shift()!.resolve();
      await tick(20);
    }

    loop.stop();
    await loop.whenDrained();
    store.close();
  });

  it("per-project cap bounds runs from one project even with global headroom", async () => {
    const store = new SqliteStateStore(":memory:");
    store.init();
    // Project p1 caps itself at 1; p2 has no cap.
    store.addProject({
      id: "p1",
      name: "p1",
      root_path: "/tmp/p1",
      default_concurrency: 1,
    });
    store.addProject({ id: "p2", name: "p2", root_path: "/tmp/p2" });
    for (let i = 0; i < 2; i++) {
      store.createRun({
        id: `p1-${i}`,
        project_id: "p1",
        status: "running",
        kind: null,
        created_at: i,
        requirement_path: "/x",
      });
    }
    store.createRun({
      id: `p2-0`,
      project_id: "p2",
      status: "running",
      kind: null,
      created_at: 99,
      requirement_path: "/x",
    });

    const seenP1 = new Set<string>();
    let p1Active = 0;
    let p1Peak = 0;
    const releases: Array<{ runId: string; resolve: () => void }> = [];

    const loop = startRunLoop({
      store,
      config: makeConfig(4), // global headroom ample
      pollIntervalMs: 5,
      logger: () => {},
      buildCtx: async ({ runId }) => fakeCtx(runId),
      pipeline: ({ runId }) => {
        if (runId.startsWith("p1-")) {
          seenP1.add(runId);
          p1Active += 1;
          p1Peak = Math.max(p1Peak, p1Active);
        }
        return new Promise<null>((resolve) => {
          releases.push({
            runId,
            resolve: () => {
              if (runId.startsWith("p1-")) p1Active -= 1;
              store.updateRun(runId, { status: "completed" });
              resolve(null);
            },
          });
        });
      },
    });

    // p1 should be capped at 1 in flight; p2 should also fit at 1.
    await waitFor(() => loop.inFlight() === 2, 1000);
    assert.equal(p1Peak, 1, "p1 must not exceed default_concurrency=1");
    assert.equal(seenP1.size, 1);

    // Drain everything.
    while (releases.length > 0) {
      releases.shift()!.resolve();
      await tick(20);
    }
    // After draining, the second p1 row should have run too.
    await waitFor(() => seenP1.size === 2, 2000);
    assert.equal(p1Peak, 1, "p1 still capped after second run picked up");

    loop.stop();
    await loop.whenDrained();
    store.close();
  });

  it("whenDrained resolves quickly when there are no in-flight runs", async () => {
    const store = new SqliteStateStore(":memory:");
    store.init();
    const loop = startRunLoop({
      store,
      config: makeConfig(2),
      pollIntervalMs: 5,
      logger: () => {},
      buildCtx: async ({ runId }) => fakeCtx(runId),
      pipeline: () => Promise.resolve(),
    });
    loop.stop();
    await loop.whenDrained();
    assert.equal(loop.inFlight(), 0);
    store.close();
  });

  it("aborting forwards abort to in-flight ctx", async () => {
    const store = new SqliteStateStore(":memory:");
    store.init();
    store.addProject({ id: "p1", name: "p1", root_path: "/tmp/p1" });
    store.createRun({
      id: "r1",
      project_id: "p1",
      status: "running",
      kind: null,
      created_at: 1,
      requirement_path: "/x",
    });

    let observedAbort = false;
    const release: { resolve: () => void } = { resolve: () => {} };

    const loop = startRunLoop({
      store,
      config: makeConfig(1),
      pollIntervalMs: 5,
      logger: () => {},
      buildCtx: async ({ runId }) => fakeCtx(runId),
      pipeline: ({ ctx, runId }) =>
        new Promise<null>((resolve) => {
          release.resolve = () => {
            store.updateRun(runId, { status: "completed" });
            resolve(null);
          };
          ctx.abortController.signal.addEventListener("abort", () => {
            observedAbort = true;
            store.updateRun(runId, { status: "killed" });
            resolve(null);
          });
        }),
    });

    await waitFor(() => loop.inFlight() === 1, 1000);
    loop.abort();
    // The pipeline closure resolves when abort fires; let the loop tick
    // and reap the run.
    await waitFor(() => loop.inFlight() === 0, 1000);
    assert.equal(observedAbort, true);
    release.resolve();
    loop.stop();
    await loop.whenDrained();
    store.close();
  });
});

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
    }
    await tick(10);
  }
}

function tick(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
