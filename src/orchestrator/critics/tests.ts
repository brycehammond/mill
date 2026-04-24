// The "tests" critic is mechanical, not model-backed. It runs the
// repo's test command (from `.df/profile.json`) inside the workdir and
// turns a non-zero exit into a HIGH finding that feeds back into the
// review loop. The other critics are Claude calls; this one is a
// subprocess. Same output contract (CriticResult), so review.ts
// aggregates it alongside the rest without special casing.

import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Finding,
  RunContext,
  Severity,
} from "../../core/index.js";
import { ZERO_USAGE, readProfile } from "../../core/index.js";
import type { CriticResult } from "./shared.js";

const execP = promisify(exec);

export interface TestsCriticArgs {
  ctx: RunContext;
  iteration: number;
  // Unused here (no system prompt), but kept in the shape to match
  // the other critic entry points so review.ts can call them uniformly.
  specBody: string;
  designBody: string;
}

// Upper bound on how long the test command can run. Tests that exceed
// this get a HIGH finding with a timeout signal.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// Prevent runaway stdout/stderr from blowing heap.
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export async function testsCritic(args: TestsCriticArgs): Promise<CriticResult> {
  const { ctx, iteration } = args;
  const profile = await readProfile(ctx.root);
  const testCmd = profile?.commands.test;
  if (!testCmd) {
    throw new Error(
      "tests critic: no test command in profile — should have been gated out by review.ts",
    );
  }

  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let timedOut = false;
  let failure: string | null = null;

  try {
    const res = await execP(testCmd, {
      cwd: ctx.paths.workdir,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      // Tests often spawn children, read env vars, or respect TERM
      // for pretty output. Inherit env.
    });
    stdout = res.stdout ?? "";
    stderr = res.stderr ?? "";
    exitCode = 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "";
    stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    if (e.killed && e.signal === "SIGTERM") {
      timedOut = true;
      exitCode = -1;
    } else if (typeof e.code === "number") {
      exitCode = e.code;
    } else {
      exitCode = -1;
      failure = e.message;
    }
  }

  const durationMs = Date.now() - startedAt;

  const findings: Finding[] = [];
  if (timedOut) {
    findings.push({
      critic: "tests",
      severity: "HIGH" as Severity,
      title: `Tests timed out after ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s`,
      evidence: truncate(
        `Command: ${testCmd}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
        4000,
      ),
      suggested_fix:
        "Investigate hanging tests or increase the test timeout; " +
        "df kills the command after 5 minutes.",
    });
  } else if (exitCode !== 0) {
    findings.push({
      critic: "tests",
      severity: "HIGH" as Severity,
      title: `Test command failed (exit ${exitCode})`,
      evidence: truncate(
        `Command: ${testCmd}\nDuration: ${durationMs}ms\n\nstdout:\n${stdout || "(empty)"}\n\nstderr:\n${stderr || "(empty)"}`,
        6000,
      ),
      suggested_fix:
        failure ??
        "Address the test failures shown in the output, or update the test " +
          "suite if the change requires new expectations.",
    });
  }

  // Every critic writes a report file; keep parity even on pass so
  // the reviews dir is self-describing.
  const reportDir = join(ctx.paths.reviewsDir, String(iteration));
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, "tests.md");
  const body = renderReport({
    testCmd,
    exitCode,
    timedOut,
    durationMs,
    stdout,
    stderr,
    findings,
  });
  await writeFile(reportPath, body, "utf8");

  // Persist findings in the same pattern as runCritic (one row per
  // finding, scoped to this iteration).
  ctx.store.transaction(() => {
    for (const f of findings) {
      ctx.store.insertFinding({
        run_id: ctx.runId,
        iteration,
        critic: "tests",
        severity: f.severity,
        title: f.title,
        detail_path: reportPath,
      });
    }
  });

  return {
    findings,
    summary:
      findings.length === 0
        ? `tests: PASS (\`${testCmd}\`, ${durationMs}ms)`
        : `tests: ${findings.length} HIGH finding`,
    cost: 0,
    usage: { ...ZERO_USAGE },
    sessionId: "",
    reportPath,
  };
}

function renderReport(args: {
  testCmd: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  findings: Finding[];
}): string {
  const status = args.timedOut
    ? "TIMEOUT"
    : args.exitCode === 0
      ? "PASS"
      : "FAIL";
  const header = [
    `# tests critic`,
    ``,
    `**Command**: \`${args.testCmd}\``,
    `**Exit**: ${args.exitCode} (${status})`,
    `**Duration**: ${args.durationMs}ms`,
    ``,
  ].join("\n");
  const findingsBlock =
    args.findings.length === 0
      ? `_No findings — tests passed._\n`
      : args.findings
          .map(
            (f) =>
              `## [${f.severity}] ${f.title}\n\n**Evidence**\n\n\`\`\`\n${f.evidence}\n\`\`\`\n\n**Suggested fix**\n\n${f.suggested_fix}\n`,
          )
          .join("\n");
  const log = [
    `## stdout\n\n\`\`\`\n${truncate(args.stdout || "(empty)", 16_000)}\n\`\`\`\n`,
    `## stderr\n\n\`\`\`\n${truncate(args.stderr || "(empty)", 16_000)}\n\`\`\`\n`,
  ].join("\n");
  return `${header}\n${findingsBlock}\n${log}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}
