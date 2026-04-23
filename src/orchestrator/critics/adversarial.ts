// Adversarial critic. Optional fourth review pass delivered by the Codex
// Claude Code plugin (`/codex:adversarial-review`). Runs when the plugin
// is installed and the `codex` CLI is authed; otherwise the critic
// returns an empty finding set and the main review loop proceeds
// unaffected.
//
// We shell out to the plugin's companion script directly rather than
// through a slash command — the slash command is only reachable from
// inside an interactive Claude Code UI, but the companion script takes
// the same arguments and writes a JSON payload we can parse.

import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  CriticName,
  Finding,
  RunContext,
  Severity,
} from "../../core/index.js";
import type { CriticResult } from "./shared.js";

const execFileP = promisify(execFile);

const CRITIC: CriticName = "adversarial";
const PLUGIN_GLOB_ROOT = join(
  homedir(),
  ".claude/plugins/cache/openai-codex/codex",
);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

let cachedCodexProbe: boolean | null = null;

// Resolve the path to the Codex plugin's companion script. Honors an
// explicit override so tests / non-standard install paths still work.
// Returns null when the plugin isn't installed.
export function findCodexCompanion(): string | null {
  const override = process.env.DF_CODEX_COMPANION?.trim();
  if (override) return existsSync(override) ? override : null;

  if (!existsSync(PLUGIN_GLOB_ROOT)) return null;
  const versions = readdirSync(PLUGIN_GLOB_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(compareVersionDesc);
  for (const v of versions) {
    const p = join(PLUGIN_GLOB_ROOT, v, "scripts", "codex-companion.mjs");
    if (existsSync(p)) return p;
  }
  return null;
}

// Cached `codex --version` probe. The companion itself runs this check
// and will fail loudly if it's missing — but probing up front lets us
// decide whether to include the critic at all.
export async function isCodexCliAvailable(): Promise<boolean> {
  if (cachedCodexProbe !== null) return cachedCodexProbe;
  try {
    await execFileP("codex", ["--version"], { timeout: 5000 });
    cachedCodexProbe = true;
  } catch {
    cachedCodexProbe = false;
  }
  return cachedCodexProbe;
}

export interface AdversarialCriticArgs {
  ctx: RunContext;
  iteration: number;
  specBody: string;
  designBody: string;
  companionPath: string;
}

export async function adversarialCritic(
  args: AdversarialCriticArgs,
): Promise<CriticResult> {
  const { ctx, iteration, specBody, designBody, companionPath } = args;
  const reportDir = join(ctx.paths.reviewsDir, String(iteration));
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, "adversarial.md");

  const focusText = buildFocusText(specBody, designBody);
  const timeoutMs = Math.max(ctx.stageTimeoutMs, DEFAULT_TIMEOUT_MS);

  let payload: CompanionPayload | null = null;
  let failureReason: string | null = null;

  try {
    payload = await runCompanion({
      companionPath,
      cwd: ctx.paths.workdir,
      focusText,
      timeoutMs,
      abortSignal: ctx.abortController.signal,
    });
  } catch (err) {
    failureReason = err instanceof Error ? err.message : String(err);
    ctx.logger.warn("adversarial critic unavailable", { err: failureReason });
  }

  if (!payload || payload.parseError || !payload.result) {
    const reason =
      failureReason ??
      payload?.parseError ??
      "codex returned no structured review output";
    const summary = `adversarial review unavailable: ${reason.slice(0, 300)}`;
    await writeFile(reportPath, `# adversarial review\n\n${summary}\n`, "utf8");
    return {
      findings: [],
      summary,
      cost: 0,
      sessionId: "",
      reportPath,
    };
  }

  const findings: Finding[] = payload.result.findings.map((f) => ({
    critic: CRITIC,
    severity: normalizeSeverity(f.severity),
    title: f.title,
    evidence: buildEvidence(f),
    suggested_fix: f.recommendation || "(no recommendation supplied)",
  }));

  const reportBody = renderReport(payload.result, findings);
  await writeFile(reportPath, reportBody, "utf8");

  ctx.store.transaction(() => {
    for (const f of findings) {
      ctx.store.insertFinding({
        run_id: ctx.runId,
        iteration,
        critic: CRITIC,
        severity: f.severity,
        title: f.title,
        detail_path: reportPath,
      });
    }
  });

  return {
    findings,
    summary: payload.result.summary,
    cost: 0,
    sessionId: payload.threadId ?? "",
    reportPath,
  };
}

interface CompanionFinding {
  severity: string;
  title: string;
  body: string;
  file: string;
  line_start: number;
  line_end: number;
  confidence: number;
  recommendation: string;
}

interface CompanionResult {
  verdict: "approve" | "needs-attention";
  summary: string;
  findings: CompanionFinding[];
  next_steps: string[];
}

interface CompanionPayload {
  threadId?: string;
  result: CompanionResult | null;
  rawOutput?: string;
  parseError?: string;
  codex?: { status?: number; stderr?: string };
}

interface RunCompanionArgs {
  companionPath: string;
  cwd: string;
  focusText: string;
  timeoutMs: number;
  abortSignal: AbortSignal;
}

async function runCompanion(args: RunCompanionArgs): Promise<CompanionPayload> {
  const { companionPath, cwd, focusText, timeoutMs, abortSignal } = args;
  const argv = [
    companionPath,
    "adversarial-review",
    "--wait",
    "--json",
    "--base",
    "impl/iter-0",
  ];
  if (focusText) argv.push(focusText);

  return await new Promise((resolve, reject) => {
    const child = spawn("node", argv, {
      cwd,
      env: {
        ...process.env,
        // Point the companion at our plugin install. It reads
        // CLAUDE_PLUGIN_ROOT for schema paths etc.
        CLAUDE_PLUGIN_ROOT: dirname(dirname(companionPath)),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    abortSignal.addEventListener("abort", onAbort);

    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        const preview = (stderr || stdout).trim().split("\n").slice(-5).join(" ");
        reject(new Error(`codex-companion exited ${code}: ${preview}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as CompanionPayload;
        resolve(parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(`failed to parse codex-companion output: ${msg}`));
      }
    });

    function cleanup() {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", onAbort);
    }
  });
}

function buildFocusText(specBody: string, designBody: string): string {
  const specHead = headline(specBody);
  const designHead = headline(designBody);
  const parts = [
    "Challenge the approach, not just the diff.",
    specHead && `Spec intent: ${specHead}`,
    designHead && `Design intent: ${designHead}`,
  ].filter(Boolean) as string[];
  return parts.join(" ");
}

function headline(body: string): string {
  const first = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  return (first ?? "").slice(0, 180);
}

function normalizeSeverity(raw: string): Severity {
  const v = String(raw ?? "").toUpperCase();
  if (v === "CRITICAL" || v === "HIGH" || v === "MEDIUM" || v === "LOW") {
    return v;
  }
  return "MEDIUM";
}

function buildEvidence(f: CompanionFinding): string {
  const body = (f.body ?? "").trim();
  const loc =
    f.file && f.line_start
      ? `\n\nLocation: ${f.file}:${f.line_start}-${f.line_end || f.line_start}`
      : "";
  const conf =
    typeof f.confidence === "number"
      ? `\nConfidence: ${f.confidence.toFixed(2)}`
      : "";
  return `${body}${loc}${conf}`.trim();
}

function renderReport(result: CompanionResult, findings: Finding[]): string {
  const header = `# adversarial review\n\n**Verdict:** ${result.verdict}\n\n${result.summary}\n`;
  const nextSteps = result.next_steps?.length
    ? `\n## Next steps\n\n${result.next_steps.map((s) => `- ${s}`).join("\n")}\n`
    : "";
  if (findings.length === 0) return `${header}${nextSteps}\n_No findings._\n`;
  const body = findings
    .map(
      (f) =>
        `## [${f.severity}] ${f.title}\n\n**Evidence**\n\n${f.evidence}\n\n**Suggested fix**\n\n${f.suggested_fix}\n`,
    )
    .join("\n");
  return `${header}\n${body}${nextSteps}`;
}

// "1.2.11" > "1.2.2" > "0.9.0". Falls back to lexicographic on
// non-numeric segments so that "unknown" or prerelease tags still sort
// somewhere deterministic.
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? "";
    const bi = pb[i] ?? "";
    const an = Number(ai);
    const bn = Number(bi);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return bn - an;
    } else {
      if (ai !== bi) return bi.localeCompare(ai);
    }
  }
  return 0;
}

export function canRunAdversarial(): {
  ok: boolean;
  companionPath: string | null;
  reason?: string;
} {
  const companionPath = findCodexCompanion();
  if (!companionPath) {
    return { ok: false, companionPath: null, reason: "codex plugin not installed" };
  }
  return { ok: true, companionPath };
}

