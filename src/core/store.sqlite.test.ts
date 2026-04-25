import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SqliteStateStore } from "./store.sqlite.js";

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
});
