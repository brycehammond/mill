import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  ApprovalRequiredError,
  BudgetPausedError,
} from "./pipeline.js";
import { KilledError } from "../core/index.js";

// The pipeline driver itself is hard to unit-test without spawning real
// `claude` subprocesses (it pulls in stages/* which call claude-cli).
// What we *can* test in isolation is the shape of the new error classes
// — the catch-block branching in pipeline.ts uses `instanceof`, so the
// error hierarchy is the load-bearing surface that other modules depend
// on. The end-to-end gate trigger lives in daemon/server.test.ts +
// budget.test.ts.

describe("pipeline error classes", () => {
  it("BudgetPausedError carries the run id in its message", () => {
    const err = new BudgetPausedError("run-42");
    assert.equal(err.name, "BudgetPausedError");
    assert.match(err.message, /run-42/);
    assert.match(err.message, /budget/);
    assert.ok(err instanceof Error);
    // Critically: NOT a KilledError. The pipeline catch block
    // discriminates on instanceof; collisions between the two would
    // route a budget pause to the kill path.
    assert.ok(!(err instanceof KilledError));
  });

  it("ApprovalRequiredError carries the gated stage name", () => {
    const err = new ApprovalRequiredError("run-7", "implement");
    assert.equal(err.name, "ApprovalRequiredError");
    assert.equal(err.atStage, "implement");
    assert.match(err.message, /run-7/);
    assert.match(err.message, /implement/);
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof KilledError));
    assert.ok(!(err instanceof BudgetPausedError));
  });

  it("the three pause/abort signal types are mutually exclusive", () => {
    const k = new KilledError("a");
    const b = new BudgetPausedError("b");
    const a = new ApprovalRequiredError("c", "design");
    assert.ok(k instanceof KilledError && !(k instanceof BudgetPausedError));
    assert.ok(b instanceof BudgetPausedError && !(b instanceof KilledError));
    assert.ok(a instanceof ApprovalRequiredError && !(a instanceof KilledError));
    assert.ok(!(a instanceof BudgetPausedError));
  });
});
