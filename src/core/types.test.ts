import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  atLeast,
  findingFingerprint,
  SEVERITY_ORDER,
  type Severity,
} from "./types.js";

describe("severity ordering", () => {
  it("orders LOW < MEDIUM < HIGH < CRITICAL", () => {
    assert.ok(SEVERITY_ORDER.LOW < SEVERITY_ORDER.MEDIUM);
    assert.ok(SEVERITY_ORDER.MEDIUM < SEVERITY_ORDER.HIGH);
    assert.ok(SEVERITY_ORDER.HIGH < SEVERITY_ORDER.CRITICAL);
  });

  it("atLeast is true when a >= b", () => {
    const cases: Array<[Severity, Severity, boolean]> = [
      ["CRITICAL", "HIGH", true],
      ["HIGH", "HIGH", true],
      ["MEDIUM", "HIGH", false],
      ["LOW", "CRITICAL", false],
      ["LOW", "LOW", true],
    ];
    for (const [a, b, want] of cases) {
      assert.equal(atLeast(a, b), want, `atLeast(${a}, ${b})`);
    }
  });
});

describe("findingFingerprint", () => {
  it("is stable across whitespace and case in the title", () => {
    const a = findingFingerprint({
      critic: "security",
      severity: "HIGH",
      title: "Token leaked in logs",
    });
    const b = findingFingerprint({
      critic: "security",
      severity: "HIGH",
      title: "  TOKEN LEAKED IN LOGS  ",
    });
    assert.equal(a, b);
  });

  it("differs when critic, severity, or title differs", () => {
    const base = {
      critic: "security" as const,
      severity: "HIGH" as const,
      title: "x",
    };
    assert.notEqual(
      findingFingerprint(base),
      findingFingerprint({ ...base, critic: "correctness" }),
    );
    assert.notEqual(
      findingFingerprint(base),
      findingFingerprint({ ...base, severity: "MEDIUM" }),
    );
    assert.notEqual(
      findingFingerprint(base),
      findingFingerprint({ ...base, title: "y" }),
    );
  });

  it("uses the documented `critic|severity|title` shape", () => {
    const fp = findingFingerprint({
      critic: "ux",
      severity: "MEDIUM",
      title: "Empty state has no copy",
    });
    assert.equal(fp, "ux|MEDIUM|empty state has no copy");
  });
});
