// Stage-level retry-with-hint. Many stages validate the shape of claude's
// output (length minimums, JSON parseability, markdown fencing) and today
// they hard-throw on validation failure — halting the pipeline for the
// user to manually resume. That's too eager. When the failure is
// recoverable via a clarifying hint ("your output was too short — emit a
// full document with these sections"), we want one more attempt with the
// hint before giving up. This helper encapsulates that pattern.
//
// Scope and deliberate non-goals:
// - One retry, not N. More than one means the model isn't understanding
//   the hint and additional attempts waste turns.
// - Only for recoverable classes (output-too-short, output-not-parseable).
//   Kill sentinels and subprocess crashes are fatal.
// - Attempts accumulate cost and usage in the DB incrementally via
//   runClaude (both attempts share the stage slot). The returned result
//   still carries the summed numbers for the caller's StageResult.cost
//   reporting in the pipeline summary.
// - Emits events via `store.appendEvent(..., "remediation", ...)` so
//   `mill tail` and `mill logs` surface the retry. Not written to
//   `.mill/journal.md` — that file is one-stanza-per-completed-run and
//   its tail gets injected into future prompts; we don't want retry
//   noise there.

import type { RunContext, StageName, TokenUsage } from "../core/index.js";
import type { RunClaudeResult } from "./claude-cli.js";

export interface RetrySpec {
  ctx: RunContext;
  stage: StageName;
  // Short label for eventing/logging, e.g. "output-too-short".
  label: string;
  // Runs the claude call. `hint` is undefined on the first try and a
  // diagnosis string on the retry attempt — callers should append it to
  // the user prompt so the model sees the specific guidance.
  attempt: (hint: string | undefined) => Promise<RunClaudeResult>;
  // Returns null if the result is acceptable; a hint string if we
  // should retry with that hint appended.
  validate: (res: RunClaudeResult) => string | null;
}

export async function runWithRetry(args: RetrySpec): Promise<RunClaudeResult> {
  const { ctx, stage, label, attempt, validate } = args;
  const first = await attempt(undefined);
  // Terminal subtypes (error_max_turns, error_during_execution) and
  // is_error=true mean the model never finished its turn — adding a
  // hint to the prompt cannot recover that. Retrying just doubles the
  // spend before failing identically. Surface the real subtype so the
  // caller can fix the underlying issue (bump maxTurns, investigate).
  // Without this guard, an `error_max_turns` produced an empty result
  // text → output-too-short validator → retry-with-hint → second
  // error_max_turns, hiding the real cause.
  throwIfTerminal(first, label, "first attempt");
  const firstHint = validate(first);
  if (firstHint === null) return first;

  ctx.logger.warn("stage validation failed — retrying with hint", {
    runId: ctx.runId,
    stage,
    label,
    hint: firstHint,
  });
  try {
    ctx.store.appendEvent(ctx.runId, stage, "remediation", {
      attempt: 1,
      label,
      status: "retrying",
      hint: firstHint,
    });
  } catch {
    // Event logging is best-effort — never let it sink the retry.
  }

  const second = await attempt(firstHint);
  throwIfTerminal(second, label, "retry attempt");
  const secondHint = validate(second);

  // Cost and usage were already accumulated into the DB by runClaude on
  // both attempts. We still roll them up in the returned result so the
  // caller's StageResult.cost (used for CLI reporting) reflects the total.
  // Session id, text, structured_output come from the *second* attempt
  // since that's the one whose output the caller is about to act on.
  const combined: RunClaudeResult = {
    ...second,
    costUsd: first.costUsd + second.costUsd,
    usage: sumUsage(first.usage, second.usage),
  };

  if (secondHint === null) {
    ctx.logger.info("stage retry recovered", { runId: ctx.runId, stage, label });
    try {
      ctx.store.appendEvent(ctx.runId, stage, "remediation", {
        attempt: 2,
        label,
        status: "recovered",
      });
    } catch {
      // ignore
    }
    return combined;
  }

  try {
    ctx.store.appendEvent(ctx.runId, stage, "remediation", {
      attempt: 2,
      label,
      status: "exhausted",
      hint: secondHint,
    });
  } catch {
    // ignore
  }
  throw new Error(`${label}: validation failed after retry (${secondHint})`);
}

function throwIfTerminal(
  res: RunClaudeResult,
  label: string,
  which: string,
): void {
  if (res.subtype === "success" && !res.isError) return;
  throw new Error(
    `${label}: claude ${which} returned ${res.subtype} (is_error=${res.isError}); retry-with-hint cannot recover from a non-success result. Likely cause: maxTurns too low, or the model errored mid-turn.`,
  );
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cache_creation: a.cache_creation + b.cache_creation,
    cache_read: a.cache_read + b.cache_read,
    output: a.output + b.output,
  };
}
