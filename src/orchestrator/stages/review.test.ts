import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Finding } from "../../core/index.js";
import { shouldStopReviewLoop } from "./review.js";

const f = (
  title: string,
  severity: Finding["severity"] = "HIGH",
  critic: Finding["critic"] = "security",
): Finding => ({
  critic,
  severity,
  title,
  evidence: "",
  suggested_fix: "",
});

describe("shouldStopReviewLoop", () => {
  it("stops when iteration reaches max", () => {
    const r = shouldStopReviewLoop({
      iteration: 3,
      maxIters: 3,
      currentHigh: [f("a")],
      previousHigh: [],
    });
    assert.equal(r.stop, true);
    assert.match(r.reason, /max iterations/);
  });

  it("stops when no HIGH+ findings remain", () => {
    const r = shouldStopReviewLoop({
      iteration: 1,
      maxIters: 3,
      currentHigh: [],
      previousHigh: [f("a")],
    });
    assert.equal(r.stop, true);
    assert.match(r.reason, /no HIGH/);
  });

  it("stops when current is a strict subset of previous (stuck)", () => {
    const r = shouldStopReviewLoop({
      iteration: 2,
      maxIters: 5,
      currentHigh: [f("a")],
      previousHigh: [f("a"), f("b")],
    });
    assert.equal(r.stop, true);
    assert.match(r.reason, /stuck/);
  });

  it("stops when current equals previous (still a subset)", () => {
    const r = shouldStopReviewLoop({
      iteration: 2,
      maxIters: 5,
      currentHigh: [f("a"), f("b")],
      previousHigh: [f("a"), f("b")],
    });
    assert.equal(r.stop, true);
    assert.match(r.reason, /stuck/);
  });

  it("continues when a new HIGH appears that was not seen before", () => {
    const r = shouldStopReviewLoop({
      iteration: 2,
      maxIters: 5,
      currentHigh: [f("a"), f("c-new")],
      previousHigh: [f("a"), f("b")],
    });
    assert.equal(r.stop, false);
  });

  it("continues on iteration 1 (no prior set to compare against)", () => {
    const r = shouldStopReviewLoop({
      iteration: 1,
      maxIters: 3,
      currentHigh: [f("a")],
      previousHigh: [],
    });
    assert.equal(r.stop, false);
  });

  it("compares by canonical fingerprint, not object identity", () => {
    // Same critic|severity|title but different evidence/suggested_fix.
    const r = shouldStopReviewLoop({
      iteration: 2,
      maxIters: 5,
      currentHigh: [{ ...f("a"), evidence: "new evidence" }],
      previousHigh: [{ ...f("a"), evidence: "old evidence" }],
    });
    assert.equal(r.stop, true);
    assert.match(r.reason, /stuck/);
  });
});
