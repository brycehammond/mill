import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  extractJsonBlock,
  extractMarkdownBlock,
  pickStructured,
  ZERO_USAGE,
} from "./claude-cli.js";
import type { RunClaudeResult } from "./claude-cli.js";

const baseResult = (
  patch: Partial<RunClaudeResult> = {},
): RunClaudeResult => ({
  text: "",
  structuredOutput: null,
  sessionId: "sess-1",
  costUsd: 0,
  usage: { ...ZERO_USAGE },
  subtype: "success",
  durationMs: 0,
  numTurns: 1,
  isError: false,
  ...patch,
});

describe("extractJsonBlock", () => {
  it("parses a fenced ```json block", () => {
    const out = extractJsonBlock<{ x: number }>(
      "preamble\n```json\n{ \"x\": 7 }\n```\ntrailing",
    );
    assert.deepEqual(out, { x: 7 });
  });

  it("parses an unfenced JSON document", () => {
    const out = extractJsonBlock<{ a: string }>(`{"a":"b"}`);
    assert.deepEqual(out, { a: "b" });
  });

  it("throws with a preview when JSON is unparseable", () => {
    assert.throws(
      () => extractJsonBlock("```json\n{ not json\n```"),
      /failed to parse JSON/,
    );
  });
});

describe("extractMarkdownBlock", () => {
  it("strips a fenced ```markdown block", () => {
    const out = extractMarkdownBlock("```markdown\n# Title\nbody\n```");
    assert.equal(out, "# Title\nbody");
  });

  it("returns trimmed body when no fence is present", () => {
    const out = extractMarkdownBlock("\n  hello world  \n");
    assert.equal(out, "hello world");
  });

  it("accepts the alternate ```md fence", () => {
    const out = extractMarkdownBlock("```md\n# h\n```");
    assert.equal(out, "# h");
  });
});

describe("pickStructured", () => {
  it("prefers structuredOutput when present", () => {
    const res = baseResult({
      structuredOutput: { picked: "structured" },
      text: "ignored",
    });
    assert.deepEqual(pickStructured(res), { picked: "structured" });
  });

  it("falls back to JSON.parse on text when structuredOutput is null", () => {
    const res = baseResult({ text: '{"from":"text"}' });
    assert.deepEqual(pickStructured(res), { from: "text" });
  });

  it("falls back to fenced extraction when text is not raw JSON", () => {
    const res = baseResult({
      text: "summary\n```json\n{\"from\":\"fence\"}\n```",
    });
    assert.deepEqual(pickStructured(res), { from: "fence" });
  });

  it("surfaces non-success subtypes as errors instead of masking parse failures", () => {
    const res = baseResult({
      subtype: "error_max_turns",
      structuredOutput: null,
      text: "",
    });
    assert.throws(() => pickStructured(res), /error_max_turns/);
  });

  it("surfaces is_error=true even on success subtype", () => {
    const res = baseResult({
      isError: true,
      structuredOutput: null,
      text: "",
    });
    assert.throws(() => pickStructured(res), /is_error=true/);
  });
});
