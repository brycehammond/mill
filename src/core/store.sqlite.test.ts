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

  // ---- Phase 3: events.actor ----

  it("events.actor backfills to 'mill' after the migration ALTER lands", () => {
    // Simulate the pre-Phase-3 schema by dropping the actor column from
    // events (the only non-additive part of the upgrade), inserting a
    // row in the "old era", then triggering the migration via init().
    // SQLite's ALTER TABLE ... ADD COLUMN ... DEFAULT 'mill' applies
    // the default to pre-existing rows.
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    s.simulateLegacyEventsSchemaForTest();
    s.insertRawEventForTest("r1", "spec", 100, "stage_started", "null");
    // Re-run init(); migrateColumns sees actor missing and re-adds it.
    s.init();
    const rows = s.tailEvents("r1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.actor, "mill");
    s.close();
  });

  it("appendEvent defaults actor to 'mill' and accepts an explicit actor", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    s.appendEvent("r1", "spec", "stage_started", null);
    s.appendEvent("r1", "spec", "approval_granted", { note: "lgtm" }, "alice");
    const rows = s.tailEvents("r1");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.actor, "mill");
    assert.equal(rows[1]!.actor, "alice");
    s.close();
  });

  it("subscribeToRunEvents receives the actor field on the EventRow", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    const seen: EventRow[] = [];
    const off = subscribeToRunEvents("r1", (row) => seen.push(row));
    try {
      s.appendEvent("r1", "deliver", "approval_required", null, "bob");
    } finally {
      off();
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.actor, "bob");
    s.close();
  });

  // ---- Phase 3: runs.awaiting_approval_at_stage + failure_reason ----

  it("updateRun accepts awaiting_approval_at_stage and failure_reason", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    s.updateRun("r1", {
      status: "awaiting_approval",
      awaiting_approval_at_stage: "implement",
    });
    let got = s.getRun("r1");
    assert.equal(got?.status, "awaiting_approval");
    assert.equal(got?.awaiting_approval_at_stage, "implement");
    assert.equal(got?.failure_reason, null);

    s.updateRun("r1", {
      status: "failed",
      failure_reason: "rejected",
      awaiting_approval_at_stage: null,
    });
    got = s.getRun("r1");
    assert.equal(got?.status, "failed");
    assert.equal(got?.failure_reason, "rejected");
    assert.equal(got?.awaiting_approval_at_stage, null);
    s.close();
  });

  it("paused_budget is a valid run status round-trip", () => {
    const s = freshStore();
    s.createRun({
      id: "r1",
      status: "running",
      kind: "ui",
      created_at: 1,
      requirement_path: "/x",
    });
    s.updateRun("r1", { status: "paused_budget" });
    assert.equal(s.getRun("r1")?.status, "paused_budget");
    s.close();
  });

  // ---- Phase 3: auth_sessions ----

  it("createAuthSession + findAuthSession round-trip", () => {
    const s = freshStore();
    const future = Date.now() + 60_000;
    const created = s.createAuthSession({
      id: "sess-1",
      actor: "alice",
      expires_at: future,
    });
    assert.equal(created.id, "sess-1");
    assert.equal(created.actor, "alice");
    assert.equal(created.expires_at, future);
    const found = s.findAuthSession("sess-1");
    assert.ok(found);
    assert.equal(found.actor, "alice");
    s.close();
  });

  it("findAuthSession returns null for an expired session", () => {
    const s = freshStore();
    s.createAuthSession({
      id: "sess-old",
      actor: "alice",
      expires_at: Date.now() - 1, // already expired
    });
    assert.equal(s.findAuthSession("sess-old"), null);
    // Row still on disk; deleteExpiredAuthSessions sweeps it.
    assert.equal(s.deleteExpiredAuthSessions(), 1);
    assert.equal(s.findAuthSession("sess-old"), null);
    s.close();
  });

  it("touchAuthSession slides the expiry and bumps last_seen_at", async () => {
    const s = freshStore();
    const future = Date.now() + 60_000;
    s.createAuthSession({
      id: "sess-1",
      actor: "alice",
      expires_at: future,
    });
    const before = s.findAuthSession("sess-1")!;
    // Tiny delay so last_seen_at advances on a fast machine.
    await new Promise((r) => setTimeout(r, 5));
    const next = future + 30_000;
    const updated = s.touchAuthSession("sess-1", next);
    assert.ok(updated);
    assert.equal(updated.expires_at, next);
    assert.ok(updated.last_seen_at >= before.last_seen_at);
    s.close();
  });

  it("touchAuthSession returns null for an unknown / expired session", () => {
    const s = freshStore();
    assert.equal(s.touchAuthSession("nope", Date.now() + 1000), null);
    s.createAuthSession({
      id: "sess-old",
      actor: "alice",
      expires_at: Date.now() - 1,
    });
    assert.equal(s.touchAuthSession("sess-old", Date.now() + 1000), null);
    s.close();
  });

  it("deleteAuthSession + deleteAllAuthSessions clear rows", () => {
    const s = freshStore();
    const future = Date.now() + 60_000;
    s.createAuthSession({ id: "a", actor: "alice", expires_at: future });
    s.createAuthSession({ id: "b", actor: "bob", expires_at: future });
    s.deleteAuthSession("a");
    assert.equal(s.findAuthSession("a"), null);
    assert.ok(s.findAuthSession("b"));
    s.deleteAllAuthSessions();
    assert.equal(s.findAuthSession("b"), null);
    s.close();
  });

  it("deleteExpiredAuthSessions reports the rows it deleted", () => {
    const s = freshStore();
    const past = Date.now() - 1;
    const future = Date.now() + 60_000;
    s.createAuthSession({ id: "a", actor: "alice", expires_at: past });
    s.createAuthSession({ id: "b", actor: "bob", expires_at: past });
    s.createAuthSession({ id: "c", actor: "carol", expires_at: future });
    assert.equal(s.deleteExpiredAuthSessions(), 2);
    assert.equal(s.deleteExpiredAuthSessions(), 0);
    s.close();
  });

  // ---- Phase 3: project_approval_gates ----

  it("setProjectGates / listProjectGates round-trip", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    assert.deepEqual(s.listProjectGates("p1-aaaa"), []);
    s.setProjectGates("p1-aaaa", ["design", "implement"]);
    assert.deepEqual(s.listProjectGates("p1-aaaa"), ["design", "implement"]);
    s.close();
  });

  it("setProjectGates fully replaces (idempotent for same set; remove on shorter set)", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    s.setProjectGates("p1-aaaa", ["design", "implement", "verify"]);
    s.setProjectGates("p1-aaaa", ["design"]);
    assert.deepEqual(s.listProjectGates("p1-aaaa"), ["design"]);
  });

  it("clearProjectGates wipes all gates for one project, leaves others alone", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    s.addProject({ id: "p2-bbbb", name: "p2", root_path: "/tmp/p2" });
    s.setProjectGates("p1-aaaa", ["design"]);
    s.setProjectGates("p2-bbbb", ["implement"]);
    s.clearProjectGates("p1-aaaa");
    assert.deepEqual(s.listProjectGates("p1-aaaa"), []);
    assert.deepEqual(s.listProjectGates("p2-bbbb"), ["implement"]);
    s.close();
  });

  // ---- Phase 3: project_webhooks ----

  it("createWebhook + getWebhook round-trip", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    const w = s.createWebhook({
      id: "wh-1",
      project_id: "p1-aaaa",
      url: "https://example.com/hook",
      event_filter: "run.completed,finding.high",
      secret: "shh",
    });
    assert.equal(w.id, "wh-1");
    assert.equal(w.enabled, true);
    assert.equal(w.consecutive_failures, 0);
    const got = s.getWebhook("wh-1");
    assert.deepEqual(got, w);
    s.close();
  });

  it("listWebhooksByProject returns rows for the given project only", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    s.addProject({ id: "p2-bbbb", name: "p2", root_path: "/tmp/p2" });
    s.createWebhook({
      id: "wh-1",
      project_id: "p1-aaaa",
      url: "https://a",
      event_filter: "run.completed",
      secret: "s",
    });
    s.createWebhook({
      id: "wh-2",
      project_id: "p2-bbbb",
      url: "https://b",
      event_filter: "run.completed",
      secret: "s",
    });
    const list = s.listWebhooksByProject("p1-aaaa");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, "wh-1");
    s.close();
  });

  it("listWebhooksByEvent filters by event name and excludes disabled", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    s.createWebhook({
      id: "wh-completed",
      project_id: "p1-aaaa",
      url: "https://a",
      event_filter: "run.completed,run.failed",
      secret: "s",
    });
    s.createWebhook({
      id: "wh-finding",
      project_id: "p1-aaaa",
      url: "https://b",
      event_filter: "finding.high",
      secret: "s",
    });
    s.createWebhook({
      id: "wh-disabled",
      project_id: "p1-aaaa",
      url: "https://c",
      event_filter: "run.completed",
      secret: "s",
      enabled: false,
    });
    const completed = s.listWebhooksByEvent("p1-aaaa", "run.completed");
    assert.deepEqual(
      completed.map((r) => r.id).sort(),
      ["wh-completed"],
    );
    const finding = s.listWebhooksByEvent("p1-aaaa", "finding.high");
    assert.deepEqual(finding.map((r) => r.id), ["wh-finding"]);
    // Bogus event matches nothing — substring collisions don't fire.
    assert.deepEqual(
      s.listWebhooksByEvent("p1-aaaa", "run.complet"),
      [],
    );
    s.close();
  });

  it("incWebhookFailures increments and returns the new count", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    s.createWebhook({
      id: "wh-1",
      project_id: "p1-aaaa",
      url: "https://a",
      event_filter: "run.completed",
      secret: "s",
    });
    assert.equal(s.incWebhookFailures("wh-1"), 1);
    assert.equal(s.incWebhookFailures("wh-1"), 2);
    assert.equal(s.incWebhookFailures("wh-1"), 3);
    s.resetWebhookFailures("wh-1");
    assert.equal(s.getWebhook("wh-1")!.consecutive_failures, 0);
    s.close();
  });

  it("disableWebhook flips enabled and excludes the row from listWebhooksByEvent", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    s.createWebhook({
      id: "wh-1",
      project_id: "p1-aaaa",
      url: "https://a",
      event_filter: "run.completed",
      secret: "s",
    });
    assert.equal(s.listWebhooksByEvent("p1-aaaa", "run.completed").length, 1);
    s.disableWebhook("wh-1");
    assert.equal(s.getWebhook("wh-1")!.enabled, false);
    assert.equal(s.listWebhooksByEvent("p1-aaaa", "run.completed").length, 0);
    s.close();
  });

  it("deleteWebhook removes the row", () => {
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    s.createWebhook({
      id: "wh-1",
      project_id: "p1-aaaa",
      url: "https://a",
      event_filter: "run.completed",
      secret: "s",
    });
    s.deleteWebhook("wh-1");
    assert.equal(s.getWebhook("wh-1"), null);
    s.close();
  });

  it("FK ON DELETE CASCADE removes gates and webhooks when the project row is hard-deleted", () => {
    // removeProject is a soft delete (sets removed_at); to exercise the
    // cascade we issue a raw DELETE via the store helper.
    const s = freshStore();
    s.addProject({ id: "p1-aaaa", name: "p1", root_path: "/tmp/p1" });
    s.setProjectGates("p1-aaaa", ["design"]);
    s.createWebhook({
      id: "wh-1",
      project_id: "p1-aaaa",
      url: "https://a",
      event_filter: "run.completed",
      secret: "s",
    });
    assert.deepEqual(s.listProjectGates("p1-aaaa"), ["design"]);
    assert.equal(s.listWebhooksByProject("p1-aaaa").length, 1);

    s.hardDeleteProjectForTest("p1-aaaa");

    assert.deepEqual(s.listProjectGates("p1-aaaa"), []);
    assert.equal(s.listWebhooksByProject("p1-aaaa").length, 0);
    s.close();
  });
});
