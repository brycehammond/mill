import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SqliteStateStore } from "./store.sqlite.js";
import { subscribeToRunEvents } from "./event-bus.js";
import type { EventRow } from "./types.js";

function freshStore(): SqliteStateStore {
  // better-sqlite3 supports `:memory:`; one DB per test for isolation.
  const s = new SqliteStateStore(":memory:");
  s.init();
  return s;
}

describe("SqliteStateStore", () => {
  it("round-trips a run", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1_700_000_000_000,
      requirement_path: "/tmp/r.md",
    });
    const row = s.getRun("r1");
    assert.ok(row);
    assert.equal(row.id, "r1");
    assert.equal(row.kind, "ui");
    assert.equal(row.mode, "new");
    assert.equal(row.total_cost_usd, 0);
    s.close();
  });

  it("addRunCost accumulates incrementally", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    s.addRunCost("r1", 0.25);
    s.addRunCost("r1", 1.0);
    assert.equal(s.getRun("r1")!.total_cost_usd, 1.25);
    s.close();
  });

  it("startStage + finishStage marks a stage completed", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "cli",
      created_at: 1,
      requirement_path: "/x",
    });
    s.startStage("r1", "spec");
    s.finishStage("r1", "spec", {
      status: "completed",
      artifact_path: "/tmp/spec.md",
    });
    const row = s.getStage("r1", "spec");
    assert.ok(row);
    assert.equal(row.status, "completed");
    assert.equal(row.artifact_path, "/tmp/spec.md");
    s.close();
  });

  it("findings carry a canonical fingerprint after insert", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "backend",
      created_at: 1,
      requirement_path: "/x",
    });
    s.insertFinding({
      run_id: "r1",
      iteration: 1,
      critic: "security",
      severity: "HIGH",
      title: "  Token Leaked  ",
      detail_path: "/tmp/sec.md",
    });
    const rows = s.listFindings("r1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.fingerprint, "security|HIGH|token leaked");
    s.close();
  });

  it("transaction rolls back on throw", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    assert.throws(() =>
      s.transaction(() => {
        s.addRunCost("r1", 5);
        throw new Error("boom");
      }),
    );
    assert.equal(s.getRun("r1")!.total_cost_usd, 0);
    s.close();
  });

  it("stage iteration rows accumulate cost + usage and round-trip", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    s.startStageIteration("r1", "implement", 1);
    s.addStageIterationCost("r1", "implement", 1, 1.0);
    s.addStageIterationCost("r1", "implement", 1, 0.5);
    s.addStageIterationUsage("r1", "implement", 1, {
      input: 100,
      cache_creation: 200,
      cache_read: 300,
      output: 50,
    });
    s.finishStageIteration("r1", "implement", 1, {
      status: "completed",
      artifact_path: "/tmp/wd",
    });

    const row = s.getStageIteration("r1", "implement", 1);
    assert.ok(row);
    assert.equal(row.cost_usd, 1.5);
    assert.equal(row.input_tokens, 100);
    assert.equal(row.cache_read_tokens, 300);
    assert.equal(row.status, "completed");
    assert.equal(row.artifact_path, "/tmp/wd");
    s.close();
  });

  it("listStageIterations returns rows ordered by iteration", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    // Insert out-of-order to confirm the ORDER BY does the work.
    for (const it of [3, 1, 2]) {
      s.startStageIteration("r1", "implement", it);
      s.addStageIterationCost("r1", "implement", it, it);
      s.finishStageIteration("r1", "implement", it, { status: "completed" });
    }
    const rows = s.listStageIterations("r1", "implement");
    assert.deepEqual(
      rows.map((r) => r.iteration),
      [1, 2, 3],
    );
    s.close();
  });

  it("listDisplayStages expands iterating stages and labels with #N", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    // Non-iterating stage: spec rolls up to one row, no suffix.
    s.startStage("r1", "spec");
    s.finishStage("r1", "spec", { status: "completed", started_at: 100, finished_at: 200 });

    // Iterating stages: implement#1, review#1, implement#2, review#2.
    // Cumulative `stages` row is set so the merge has something to
    // pivot from; iteration rows carry the per-iter timing/cost.
    s.startStage("r1", "implement");
    s.startStage("r1", "review");
    for (const it of [1, 2]) {
      s.startStageIteration("r1", "implement", it);
      s.finishStageIteration("r1", "implement", it, {
        status: "completed",
        started_at: 1000 + it * 1000,
        finished_at: 1500 + it * 1000,
      });
      s.startStageIteration("r1", "review", it);
      s.finishStageIteration("r1", "review", it, {
        status: "completed",
        started_at: 1600 + it * 1000,
        finished_at: 1900 + it * 1000,
      });
    }
    s.finishStage("r1", "implement", { status: "completed" });
    s.finishStage("r1", "review", { status: "completed" });

    const rows = s.listDisplayStages("r1");
    const names = rows.map((r) => r.displayName);
    assert.deepEqual(names, [
      "spec",
      "implement #1",
      "review #1",
      "implement #2",
      "review #2",
    ]);
    // Spec has iteration=null, the rest carry their iteration number.
    assert.equal(rows[0]!.iteration, null);
    assert.equal(rows[1]!.iteration, 1);
    assert.equal(rows[4]!.iteration, 2);
    s.close();
  });

  it("listDisplayStages suppresses #1 suffix when only one iteration ran", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    s.startStage("r1", "implement");
    s.finishStage("r1", "implement", { status: "completed", started_at: 100, finished_at: 200 });
    s.startStageIteration("r1", "implement", 1);
    s.finishStageIteration("r1", "implement", 1, {
      status: "completed",
      started_at: 100,
      finished_at: 200,
    });

    const rows = s.listDisplayStages("r1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.displayName, "implement");
    // The iteration field is still set so the ticker / status table can
    // annotate review rows by iteration number even when only one ran.
    assert.equal(rows[0]!.iteration, 1);
    s.close();
  });

  it("ledger entries aggregate across runs by fingerprint", () => {
    const s = freshStore();
    for (const id of ["r1", "r2"]) {
      s.createRun({
        id,
        status: "running",
        kind: "ui",
        created_at: 1,
        requirement_path: "/x",
      });
      s.insertFinding({
        run_id: id,
        iteration: 1,
        critic: "ux",
        severity: "MEDIUM",
        title: "Empty state has no copy",
        detail_path: "/tmp/ux.md",
      });
    }
    const entries = s.listLedgerEntries();
    const recurring = entries.find((e) =>
      e.fingerprint.startsWith("ux|MEDIUM|"),
    );
    assert.ok(recurring);
    assert.equal(recurring!.runCount, 2);
    s.close();
  });

  it("project CRUD round-trips and listProjects hides removed by default", () => {
    const s = freshStore();
    const p = s.addProject({
      id: "alpha-1234",
      name: "alpha",
      root_path: "/tmp/alpha",
    });
    assert.equal(p.id, "alpha-1234");
    assert.equal(p.removed_at, null);
    assert.equal(p.monthly_budget_usd, null);

    const byId = s.getProject("alpha-1234");
    assert.ok(byId);
    assert.equal(byId.root_path, "/tmp/alpha");

    const byPath = s.getProjectByPath("/tmp/alpha");
    assert.equal(byPath?.id, "alpha-1234");

    s.addProject({
      id: "beta-5678",
      name: "beta",
      root_path: "/tmp/beta",
    });
    assert.equal(s.listProjects().length, 2);

    s.removeProject("beta-5678");
    assert.equal(s.listProjects().length, 1);
    assert.equal(s.listProjects({ includeRemoved: true }).length, 2);
    s.close();
  });

  it("addProject rejects duplicate root_path via UNIQUE constraint", () => {
    const s = freshStore();
    s.addProject({
      id: "alpha-1234",
      name: "alpha",
      root_path: "/tmp/alpha",
    });
    assert.throws(() =>
      s.addProject({
        id: "different-id",
        name: "alpha-clone",
        root_path: "/tmp/alpha",
      }),
    );
    s.close();
  });

  it("createRun accepts project_id and listRuns can filter by it", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    s.addProject({ id: "p2-bbbb", name: "p2", root_path: "/tmp/p2" });
    s.createRun({
      id: "r1",
      project_id: "p1-aaaa",
      status: "running",
      kind: "cli",
      created_at: 1,
      requirement_path: "/x",
    });
    s.createRun({
      id: "r2",
      project_id: "p2-bbbb",
      status: "running",
      kind: "cli",
      created_at: 2,
      requirement_path: "/y",
    });
    const onlyP1 = s.listRuns({ projectId: "p1-aaaa" });
    assert.equal(onlyP1.length, 1);
    assert.equal(onlyP1[0]!.id, "r1");
    assert.equal(onlyP1[0]!.project_id, "p1-aaaa");

    s.setRunProjectId("r1", "p2-bbbb");
    assert.equal(s.getRun("r1")!.project_id, "p2-bbbb");
    s.close();
  });

  it("appendEvent fans out on the in-process event bus after INSERT", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    const seen: EventRow[] = [];
    const unsub = subscribeToRunEvents("r1", (row) => seen.push(row));
    try {
      s.appendEvent("r1", "spec", "stage_started", { foo: "bar" });
      s.appendEvent("r1", "spec", "stage_completed", null);
    } finally {
      unsub();
    }
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.run_id, "r1");
    assert.equal(seen[0]!.stage, "spec");
    assert.equal(seen[0]!.kind, "stage_started");
    assert.equal(JSON.parse(seen[0]!.payload_json).foo, "bar");
    // ids are autoincrement and ordered.
    assert.ok(seen[1]!.id > seen[0]!.id);
    s.close();
  });

  it("appendEvent does not cross-fire to other run subscribers", () => {
    const s = freshStore();
    for (const id of ["r1", "r2"]) {
      s.createRun({
        id,
        status: "running",
        kind: "ui",
        created_at: 1,
        requirement_path: "/x",
      });
    }
    let r1Count = 0;
    let r2Count = 0;
    const off1 = subscribeToRunEvents("r1", () => (r1Count += 1));
    const off2 = subscribeToRunEvents("r2", () => (r2Count += 1));
    try {
      s.appendEvent("r1", "spec", "k", null);
      s.appendEvent("r1", "spec", "k", null);
      s.appendEvent("r2", "spec", "k", null);
    } finally {
      off1();
      off2();
    }
    assert.equal(r1Count, 2);
    assert.equal(r2Count, 1);
    s.close();
  });

  it("appendEvent does not fire when the INSERT throws", () => {
    const s = freshStore();
    // run_id is NOT NULL but has no FK; force a NOT NULL violation by
    // passing undefined through a typed cast.
    let fired = 0;
    const off = subscribeToRunEvents("nope", () => (fired += 1));
    try {
      assert.throws(() =>
        s.appendEvent(
          undefined as unknown as string,
          "spec",
          "k",
          null,
        ),
      );
    } finally {
      off();
    }
    assert.equal(fired, 0);
    s.close();
  });

  it("updateProjectBudget and updateProjectConcurrency persist", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    s.updateProjectBudget("p1-aaaa", 200);
    s.updateProjectConcurrency("p1-aaaa", 4);
    const got = s.getProject("p1-aaaa");
    assert.equal(got?.monthly_budget_usd, 200);
    assert.equal(got?.default_concurrency, 4);
    s.close();
  });
});
