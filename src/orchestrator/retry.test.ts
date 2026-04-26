import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { RunContext } from "../core/index.js";
import { ZERO_USAGE } from "../core/index.js";
import type { RunClaudeResult } from "./claude-cli.js";
import { runWithRetry } from "./retry.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return noopLogger;
  },
};

function fakeCtx(): RunContext {
  // Only the bits runWithRetry actually touches: runId, logger.warn /
  // .info, store.appendEvent. Cast through unknown — fully implementing
  // RunContext / StateStore for a unit test would dwarf the test itself.
  return {
    runId: "test",
    store: { appendEvent() {} } as unknown as RunContext["store"],
    logger: noopLogger as unknown as RunContext["logger"],
  } as unknown as RunContext;
}

const result = (patch: Partial<RunClaudeResult> = {}): RunClaudeResult => ({
  text: "",
  structuredOutput: null,
  sessionId: "s",
  costUsd: 0,
  usage: { ...ZERO_USAGE },
  subtype: "success",
  durationMs: 0,
  numTurns: 1,
  isError: false,
  ...patch,
});

describe("runWithRetry", () => {
  it("returns the first result when validate is null", async () => {
    let calls = 0;
    const r = await runWithRetry({
      ctx: fakeCtx(),
      stage: "spec",
      label: "ok",
      attempt: async () => {
        calls += 1;
        return result({ text: "valid" });
      },
      validate: () => null,
    });
    assert.equal(calls, 1);
    assert.equal(r.text, "valid");
  });

  it("retries with the hint and recovers when second pass validates", async () => {
    let calls = 0;
    const seenHints: Array<string | undefined> = [];
    const r = await runWithRetry({
      ctx: fakeCtx(),
      stage: "spec",
      label: "shape",
      attempt: async (hint) => {
        seenHints.push(hint);
        calls += 1;
        return result({ text: calls === 1 ? "bad" : "good" });
      },
      validate: (r) => (r.text === "good" ? null : "be better"),
    });
    assert.equal(calls, 2);
    assert.deepEqual(seenHints, [undefined, "be better"]);
    assert.equal(r.text, "good");
  });

  it("does NOT retry when first attempt returned error_max_turns — that is not recoverable via hint", async () => {
    let calls = 0;
    await assert.rejects(
      runWithRetry({
        ctx: fakeCtx(),
        stage: "spec",
        label: "shape",
        attempt: async () => {
          calls += 1;
          return result({ subtype: "error_max_turns", text: "" });
        },
        // Validate would normally request a retry on empty text, but the
        // terminal-subtype guard should preempt it.
        validate: () => "too short",
      }),
      /error_max_turns/,
    );
    assert.equal(calls, 1, "must not invoke a second attempt on terminal subtype");
  });

  it("does NOT retry when first attempt has is_error=true", async () => {
    let calls = 0;
    await assert.rejects(
      runWithRetry({
        ctx: fakeCtx(),
        stage: "spec",
        label: "shape",
        attempt: async () => {
          calls += 1;
          return result({ isError: true });
        },
        validate: () => "retry me",
      }),
      /is_error=true/,
    );
    assert.equal(calls, 1);
  });

  it("throws if the retry attempt also returned a terminal subtype", async () => {
    let calls = 0;
    await assert.rejects(
      runWithRetry({
        ctx: fakeCtx(),
        stage: "spec",
        label: "shape",
        attempt: async () => {
          calls += 1;
          // First: success-but-bad-shape (triggers retry).
          // Second: terminal subtype (should propagate).
          return calls === 1
            ? result({ text: "bad" })
            : result({ subtype: "error_during_execution", text: "" });
        },
        validate: (r) => (r.text === "bad" ? "fix it" : "still bad"),
      }),
      /error_during_execution/,
    );
    assert.equal(calls, 2);
  });

  it("throws after retry exhaustion when both attempts validated badly (not terminal)", async () => {
    let calls = 0;
    await assert.rejects(
      runWithRetry({
        ctx: fakeCtx(),
        stage: "spec",
        label: "shape",
        attempt: async () => {
          calls += 1;
          return result({ text: "bad" });
        },
        validate: () => "still bad",
      }),
      /validation failed after retry/,
    );
    assert.equal(calls, 2);
  });
});
