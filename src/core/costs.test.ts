import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CostTrackerImpl } from "./costs.js";
import type { TokenUsage } from "./types.js";

const usage = (
  input = 0,
  cache_creation = 0,
  cache_read = 0,
  output = 0,
): TokenUsage => ({ input, cache_creation, cache_read, output });

describe("CostTrackerImpl", () => {
  it("starts at zero with no seed", () => {
    const c = new CostTrackerImpl();
    assert.equal(c.runTotal(), 0);
    assert.equal(c.stageTotal("implement"), 0);
    assert.deepEqual(c.runUsageTotal(), usage());
  });

  it("seeds run total from prior cost (resume case)", () => {
    const c = new CostTrackerImpl(12.34);
    assert.equal(c.runTotal(), 12.34);
    // Stage tallies are not seeded — only the run total carries over.
    assert.equal(c.stageTotal("implement"), 0);
  });

  it("accumulates cost across stages", () => {
    const c = new CostTrackerImpl();
    c.addCost("implement", 1.5);
    c.addCost("implement", 0.5);
    c.addCost("review", 3.0);
    assert.equal(c.stageTotal("implement"), 2.0);
    assert.equal(c.stageTotal("review"), 3.0);
    assert.equal(c.runTotal(), 5.0);
  });

  it("ignores non-finite or negative costs", () => {
    const c = new CostTrackerImpl();
    c.addCost("implement", NaN);
    c.addCost("implement", -1);
    c.addCost("implement", Infinity);
    assert.equal(c.runTotal(), 0);
    assert.equal(c.stageTotal("implement"), 0);
  });

  it("accumulates token usage per stage and run", () => {
    const c = new CostTrackerImpl();
    c.addUsage("implement", usage(10, 100, 1000, 5));
    c.addUsage("implement", usage(2, 0, 50, 1));
    c.addUsage("review", usage(0, 200, 0, 0));
    assert.deepEqual(c.stageUsageTotal("implement"), usage(12, 100, 1050, 6));
    assert.deepEqual(c.stageUsageTotal("review"), usage(0, 200, 0, 0));
    assert.deepEqual(c.runUsageTotal(), usage(12, 300, 1050, 6));
  });

  it("snapshot returns a deep copy that does not aliase internal state", () => {
    const c = new CostTrackerImpl();
    c.addCost("implement", 1);
    c.addUsage("implement", usage(1, 2, 3, 4));
    const snap = c.snapshot();
    snap.run = 999;
    snap.byStage.implement = 999;
    snap.runUsage.input = 999;
    assert.equal(c.runTotal(), 1);
    assert.equal(c.stageTotal("implement"), 1);
    assert.deepEqual(c.runUsageTotal(), usage(1, 2, 3, 4));
  });

  it("snapshot reports per-stage cost and usage breakdown", () => {
    const c = new CostTrackerImpl(0.5);
    c.addCost("implement", 1);
    c.addCost("review", 2);
    c.addUsage("implement", usage(10, 0, 0, 0));
    const snap = c.snapshot();
    assert.equal(snap.run, 3.5);
    assert.equal(snap.byStage.implement, 1);
    assert.equal(snap.byStage.review, 2);
    assert.deepEqual(snap.byStageUsage.implement, usage(10, 0, 0, 0));
  });
});
