#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { writeFile, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import {
  openStore,
  runPaths,
  initProject,
  readProjectInfo,
  detectRunMode,
  readJournal,
  journalPath,
  type Clarifications,
  type RunMode,
} from "./core/index.js";
import {
  buildContext,
  intake,
  clarify,
  recordAnswers,
  runPipeline,
  loadConfig,
  NoProjectError,
  onboard,
} from "./orchestrator/index.js";

type Cmd =
  | "new"
  | "run"
  | "status"
  | "logs"
  | "tail"
  | "kill"
  | "init"
  | "onboard"
  | "history"
  | "findings"
  | "help";

async function main() {
  const [, , cmdRaw, ...rest] = process.argv;
  const cmd = (cmdRaw ?? "help") as Cmd;

  try {
    switch (cmd) {
      case "init":
        return await cmdInit(rest);
      case "new":
        return await cmdNew(rest);
      case "run":
        return await cmdRun(rest);
      case "status":
        return await cmdStatus(rest);
      case "logs":
        return await cmdLogs(rest);
      case "tail":
        return await cmdTail(rest);
      case "kill":
        return await cmdKill(rest);
      case "history":
        return await cmdHistory();
      case "onboard":
        return await cmdOnboard(rest);
      case "findings":
        return await cmdFindings(rest);
      case "help":
      default:
        printHelp();
        return;
    }
  } catch (err) {
    if (err instanceof NoProjectError) {
      console.error(`df: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

function preflightClaude(): void {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    console.error(
      "df: `claude` CLI not found on PATH.\n" +
        "Install with: npm i -g @anthropic-ai/claude-code",
    );
    process.exit(1);
  }
}

function printHelp() {
  process.stdout.write(
    [
      "df — dark factory: a harness around the claude CLI",
      "",
      "usage:",
      "  df init [<name>]                  # create .df/ in the current git repo",
      "  df new (<requirement...> | --from <file>) [--mode new|edit|auto]",
      "         [--stop-after spec|design|spec2tests] [--pr]",
      "         [--detach] [--all-defaults]",
      "    --mode auto (default) detects edit when the repo has committed",
      "    source; otherwise scaffolds into .df/runs/<id>/workdir/. Edit",
      "    runs create a df/run-<id> branch via git worktree.",
      "    --stop-after halts the pipeline after the named stage so you can",
      "    review before paying for the rest. Resume with `df run <id>`.",
      "    (Unrelated to Claude Code's permissionMode: plan.)",
      "    --pr pushes the branch and opens a GitHub PR via gh (edit only).",
      "  df run <run-id>                   # resume a run, skipping completed stages",
      "  df status [<run-id>]",
      "  df tail <run-id> [--follow]      # human-readable activity stream",
      "  df logs <run-id> [--follow] [--after <event-id>]  # raw events",
      "  df kill <run-id>",
      "  df onboard [--refresh]           # profile the repo once; auto-injected",
      "                                    into future spec/design/implement prompts",
      "  df history                        # print .df/journal.md",
      "  df findings [--all] [--limit N]  # recurring findings across runs",
      "  df findings suppress <fingerprint> [--note <text>]",
      "  df findings unsuppress <fingerprint>",
      "  df findings suppressed           # list suppressed fingerprints",
      "",
    ].join("\n"),
  );
}

async function cmdInit(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
    },
  });
  const name = values.name ?? positionals[0];
  const result = initProject({ name });
  if (result.created) {
    console.log(`initialized df project "${result.info.name}" at ${result.projectRoot}`);
  } else {
    console.log(
      `df project "${result.info.name}" already initialized at ${result.projectRoot} (re-registered)`,
    );
  }
  if (result.gitignoreUpdated) {
    console.log("added /.df/ to .gitignore");
  }
}

async function cmdNew(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      detach: { type: "boolean", default: false },
      "all-defaults": { type: "boolean", default: false },
      from: { type: "string" },
      mode: { type: "string", default: "auto" },
      pr: { type: "boolean", default: false },
      "stop-after": { type: "string" },
    },
  });

  const positionalText = positionals.join(" ").trim();
  const fromPath = values.from;

  if (fromPath && positionalText) {
    console.error(
      "df new: pass the requirement either positionally or via --from, not both",
    );
    process.exitCode = 2;
    return;
  }

  const rawMode = (values.mode ?? "auto").toLowerCase();
  if (rawMode !== "auto" && rawMode !== "new" && rawMode !== "edit") {
    console.error(`df new: --mode must be auto|new|edit, got "${values.mode}"`);
    process.exitCode = 2;
    return;
  }

  let requirement: string;
  if (fromPath) {
    try {
      requirement = (await readFile(fromPath, "utf8")).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`df new: could not read --from ${fromPath}: ${msg}`);
      process.exitCode = 2;
      return;
    }
  } else {
    requirement = positionalText;
  }

  if (!requirement) {
    console.error(
      fromPath
        ? `df new: --from file ${fromPath} is empty`
        : "df new: requirement is required",
    );
    process.exitCode = 2;
    return;
  }

  preflightClaude();

  const config = loadConfig();
  const store = openStore(config.root);

  const effectiveMode: RunMode =
    rawMode === "auto" ? await detectRunMode(config.root) : (rawMode as RunMode);
  const prFlag = Boolean(values.pr);
  if (prFlag && effectiveMode === "new") {
    console.error("df new: --pr requires edit mode");
    process.exitCode = 2;
    return;
  }

  if (rawMode === "auto") {
    console.log(
      `df: auto-detected mode=${effectiveMode}. Override with --mode new|edit.`,
    );
  } else {
    console.log(`df: mode=${effectiveMode}`);
  }

  let intakeResult;
  try {
    intakeResult = await intake({
      requirement,
      root: config.root,
      store,
      mode: effectiveMode,
      pr: prFlag,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`df new: intake failed: ${msg}`);
    process.exitCode = 1;
    return;
  }
  const { runId, branch, baseBranch } = intakeResult;
  console.log(`run created: ${runId}`);
  if (effectiveMode === "edit" && branch) {
    console.log(`branch: ${branch}${baseBranch ? ` (off ${baseBranch})` : ""}`);
  }

  const ctx = await buildContext({ runId, config, store });
  console.log("running clarify…");
  const clarifyRes = await clarify(ctx);
  if (!clarifyRes.ok) {
    console.error(`clarify failed: ${clarifyRes.error}`);
    process.exitCode = 1;
    return;
  }

  const clar = store.getClarifications(runId);
  if (!clar) throw new Error("clarifications not stored");

  console.log(`\nkind: ${clar.kind}`);
  const answers = await promptForAnswers(clar, Boolean(values["all-defaults"]));
  await recordAnswers(ctx, answers);
  console.log("\nanswers recorded. run is now dark.\n");

  if (values.detach) {
    console.log(
      "detach: run is queued with status=running. launch `npm run worker` to execute it.",
    );
    return;
  }

  // --stop-after <stage> halts the pipeline after a named stage so the
  // user can review before paying for the rest. Unrelated to Claude
  // Code's `permissionMode: plan` (in-process planning).
  const stopAfter = resolveStopAfter(values["stop-after"]);
  if (stopAfter === "error") {
    process.exitCode = 2;
    return;
  }
  if (stopAfter) {
    console.log(`running pipeline inline (will stop after ${stopAfter})`);
  } else {
    console.log("running pipeline inline (spec → design → implement ⇄ review → verify → deliver)");
  }
  installInlineAbortHandler(ctx);
  const result = await runPipeline({
    runId,
    config,
    ctx,
    ...(stopAfter ? { stopAfter } : {}),
  });
  console.log("\n=== pipeline result ===");
  console.log(JSON.stringify(result, null, 2));
  const paths = runPaths(config.root, runId);
  if (stopAfter) {
    if (stopAfter === "spec") {
      console.log(`\nspec: ${paths.spec}`);
    } else if (stopAfter === "design" || stopAfter === "spec2tests") {
      console.log(`\nspec:         ${paths.spec}`);
      console.log(`architecture: ${paths.architecture}`);
    }
    console.log(`\nreview those files, then continue with:`);
    console.log(`  df run ${runId}`);
  } else {
    console.log(`\ndelivery: ${paths.delivery}`);
    console.log(`workdir:  ${paths.workdir}`);
  }
}

type StopStage = "spec" | "design" | "spec2tests";
const STOP_STAGES: StopStage[] = ["spec", "design", "spec2tests"];

function resolveStopAfter(raw: string | undefined): StopStage | undefined | "error" {
  const v = raw?.trim();
  if (!v) return undefined;
  if (!STOP_STAGES.includes(v as StopStage)) {
    console.error(
      `df new: --stop-after must be one of ${STOP_STAGES.join("|")}, got "${v}"`,
    );
    return "error";
  }
  return v as StopStage;
}

async function cmdRun(argv: string[]) {
  const runId = argv[0];
  if (!runId) {
    console.error("df run: run-id required");
    process.exitCode = 2;
    return;
  }
  preflightClaude();
  const config = loadConfig();
  const store = openStore(config.root);
  const run = store.getRun(runId);
  if (!run) {
    console.error(`no run: ${runId}`);
    process.exitCode = 1;
    return;
  }
  if (run.status === "completed") {
    console.log(`run ${runId} already completed; nothing to do`);
    return;
  }
  if (run.status === "killed") {
    console.log(`run ${runId} killed; remove runs/<id>/KILLED to retry`);
    return;
  }
  const ctx = await buildContext({ runId, config, store });
  console.log(`resuming ${runId} (status=${run.status})`);
  installInlineAbortHandler(ctx);
  const result = await runPipeline({ runId, config, ctx });
  console.log(JSON.stringify(result, null, 2));
}

// Hook SIGINT/SIGTERM during an inline pipeline run. First signal aborts the
// context (propagates SIGTERM → SIGKILL to the claude subprocess via
// runClaude.onAbort); pipeline.ts catches KilledError and records the run as
// killed. Second signal gives up and exits immediately.
function installInlineAbortHandler(ctx: {
  abortController: AbortController;
}): void {
  let firstSignal = true;
  const handler = (signal: NodeJS.Signals) => {
    if (firstSignal) {
      firstSignal = false;
      process.stderr.write(
        `\n${signal}: aborting run — send again to force exit\n`,
      );
      ctx.abortController.abort();
      return;
    }
    process.stderr.write(`\n${signal} (again): forcing exit\n`);
    process.exit(130);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

async function promptForAnswers(
  clar: Clarifications,
  allDefaults: boolean,
): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  if (clar.questions.length === 0) {
    console.log("no clarifying questions needed.");
    return answers;
  }

  if (allDefaults) {
    for (const q of clar.questions) {
      answers[q.id] = q.default ?? "";
    }
    return answers;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (const [i, q] of clar.questions.entries()) {
      process.stdout.write(
        `\nQ${i + 1}/${clar.questions.length}. ${q.question}\n  (why: ${q.why})\n`,
      );
      const promptLine = q.default
        ? `  [default: ${q.default}] > `
        : `  > `;
      const raw = (await rl.question(promptLine)).trim();
      answers[q.id] = raw || (q.default ?? "");
    }
  } finally {
    rl.close();
  }
  return answers;
}

async function cmdOnboard(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      refresh: { type: "boolean", default: false },
    },
  });
  preflightClaude();
  const refresh = Boolean(values.refresh);
  console.log(
    refresh
      ? "df onboard: refreshing profile (reading repo, calling claude)…"
      : "df onboard: checking for existing profile…",
  );
  const result = await onboard({ refresh });
  if (result.cached) {
    console.log("profile already exists. Run `df onboard --refresh` to rebuild.");
    return;
  }
  const config = loadConfig();
  console.log(
    `profile written: ${config.root}/.df/profile.md`,
  );
  console.log(`cost: $${result.costUsd.toFixed(4)}  duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`stack: ${result.profile.stack}`);
  const cmds = result.profile.commands;
  const present = (label: string, v: string | null) =>
    v ? `  ${label}: ${v}` : `  ${label}: (none detected)`;
  console.log(present("test", cmds.test));
  console.log(present("build", cmds.build));
  console.log(present("lint", cmds.lint));
  console.log(present("typecheck", cmds.typecheck));
}

async function cmdFindings(argv: string[]) {
  const sub = argv[0];
  if (sub === "suppress" || sub === "unsuppress") {
    const fp = argv[1];
    if (!fp) {
      console.error(`df findings ${sub}: fingerprint required`);
      process.exitCode = 2;
      return;
    }
    const { values } = parseArgs({
      args: argv.slice(2),
      allowPositionals: false,
      options: { note: { type: "string" } },
    });
    const config = loadConfig();
    const store = openStore(config.root);
    if (sub === "suppress") {
      store.suppressFingerprint(fp, values.note);
      console.log(`suppressed: ${fp}`);
    } else {
      store.unsuppressFingerprint(fp);
      console.log(`unsuppressed: ${fp}`);
    }
    return;
  }
  if (sub === "suppressed") {
    const config = loadConfig();
    const store = openStore(config.root);
    const rows = store.listSuppressedFingerprints();
    if (rows.length === 0) {
      console.log("(none)");
      return;
    }
    for (const r of rows) {
      const when = new Date(r.added_at).toISOString();
      console.log(`${when}  ${r.fingerprint}${r.note ? `  — ${r.note}` : ""}`);
    }
    return;
  }

  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      all: { type: "boolean", default: false },
      limit: { type: "string", default: "50" },
      "include-suppressed": { type: "boolean", default: false },
    },
  });
  const config = loadConfig();
  const store = openStore(config.root);
  // Default view = recurring (seen in ≥2 runs). --all lowers the gate
  // to ≥1 so the user can see every distinct fingerprint.
  const minRuns = values.all ? 1 : 2;
  const limit = Number(values.limit ?? "50");
  const entries = store.listLedgerEntries({
    minRuns,
    includeSuppressed: Boolean(values["include-suppressed"]),
    limit,
  });
  if (entries.length === 0) {
    console.log(values.all ? "(no findings on record)" : "(no recurring findings — use --all to see singletons)");
    return;
  }
  console.log(
    `runs  sev       critic         last-seen              title`,
  );
  for (const e of entries) {
    const last = new Date(e.lastSeen).toISOString();
    const flag = e.suppressed ? " (suppressed)" : "";
    console.log(
      [
        String(e.runCount).padStart(4),
        e.severity.padEnd(9),
        e.critic.padEnd(14),
        last,
        e.title + flag,
      ].join("  "),
    );
    console.log(`      fp: ${e.fingerprint}`);
    if (e.exampleDetailPath) console.log(`      ↳ ${e.exampleDetailPath}`);
  }
}

async function cmdHistory() {
  const config = loadConfig();
  const body = await readJournal(config.root);
  if (!body.trim()) {
    console.log("(no journal yet)");
    console.log(`will be written to: ${journalPath(config.root)}`);
    return;
  }
  process.stdout.write(body.endsWith("\n") ? body : body + "\n");
}

async function cmdStatus(argv: string[]) {
  const config = loadConfig();
  const store = openStore(config.root);
  const runId = argv[0];
  if (!runId) {
    const info = readProjectInfo(config.root);
    if (info) {
      console.log(`project: ${info.name} (${config.root})`);
      console.log();
    }
    const rows = store.listRuns({ limit: 20 });
    if (rows.length === 0) {
      console.log("(no runs)");
      return;
    }
    console.log("id                       status               mode  kind     cost       created");
    for (const r of rows) {
      console.log(
        [
          r.id.padEnd(24),
          r.status.padEnd(20),
          (r.mode ?? "new").padEnd(5),
          (r.kind ?? "—").padEnd(8),
          `$${r.total_cost_usd.toFixed(4)}`.padEnd(10),
          new Date(r.created_at).toISOString(),
        ].join(" "),
      );
    }
    return;
  }
  const run = store.getRun(runId);
  if (!run) {
    console.error(`no run: ${runId}`);
    process.exitCode = 1;
    return;
  }
  const stages = store.listStages(runId);
  const runTokens = totalTokens(run);
  console.log(`run ${runId}`);
  console.log(
    `status: ${run.status}  mode: ${run.mode ?? "new"}  kind: ${run.kind ?? "—"}  cost: $${run.total_cost_usd.toFixed(4)}  tokens: ${fmtTokens(run.total_input_tokens, run.total_cache_creation_tokens, run.total_cache_read_tokens, run.total_output_tokens)} (total ${runTokens.toLocaleString()})`,
  );
  console.log();
  console.log("stage        status       cost        in     cc      cr       out    started");
  for (const s of stages) {
    console.log(
      [
        s.name.padEnd(12),
        s.status.padEnd(12),
        `$${s.cost_usd.toFixed(4)}`.padEnd(11),
        compactTokens(s.input_tokens).padStart(6),
        compactTokens(s.cache_creation_tokens).padStart(7),
        compactTokens(s.cache_read_tokens).padStart(8),
        compactTokens(s.output_tokens).padStart(6),
        s.started_at ? new Date(s.started_at).toISOString() : "—",
      ].join(" "),
    );
  }
}

// Format token counts for the compact per-stage column: 1.2k, 342, 4.8M, etc.
function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtTokens(input: number, cc: number, cr: number, out: number): string {
  return `in=${compactTokens(input)} cc=${compactTokens(cc)} cr=${compactTokens(cr)} out=${compactTokens(out)}`;
}

function totalTokens(r: {
  total_input_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_output_tokens: number;
}): number {
  return (
    r.total_input_tokens +
    r.total_cache_creation_tokens +
    r.total_cache_read_tokens +
    r.total_output_tokens
  );
}

async function cmdLogs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      follow: { type: "boolean", short: "f", default: false },
      after: { type: "string" },
      limit: { type: "string", default: "200" },
    },
  });
  const runId = positionals[0];
  if (!runId) {
    console.error("df logs: run-id required");
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const store = openStore(config.root);
  let after = values.after ? Number(values.after) : 0;
  const limit = Number(values.limit ?? "200");

  const dump = () => {
    const events = store.tailEvents(runId, after, limit);
    for (const e of events) {
      const payload = safeParse(e.payload_json);
      const line = compactEvent(e.ts, e.stage, e.kind, payload);
      console.log(line);
      after = e.id;
    }
  };

  dump();
  if (!values.follow) return;

  // Poll every second until the process is interrupted.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(1000);
    const run = store.getRun(runId);
    dump();
    if (run && (run.status === "completed" || run.status === "failed" || run.status === "killed")) {
      break;
    }
  }
}

async function cmdTail(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      follow: { type: "boolean", short: "f", default: false },
      after: { type: "string" },
    },
  });
  const runId = positionals[0];
  if (!runId) {
    console.error("df tail: run-id required");
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const store = openStore(config.root);
  const run = store.getRun(runId);
  if (!run) {
    console.error(`no run: ${runId}`);
    process.exitCode = 1;
    return;
  }
  const paths = runPaths(config.root, runId);
  let after = values.after ? Number(values.after) : 0;
  let lastStage = "";

  const dump = () => {
    const events = store.tailEvents(runId, after, 500);
    for (const e of events) {
      if (e.stage !== lastStage) {
        process.stdout.write(`══ ${e.stage} ══\n`);
        lastStage = e.stage;
      }
      const payload = safeParse(e.payload_json);
      const line = renderTailLine(e.kind, payload, paths.workdir);
      if (line !== null) process.stdout.write(line + "\n");
      after = e.id;
    }
  };

  dump();
  if (!values.follow) return;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(1000);
    const r = store.getRun(runId);
    dump();
    if (r && (r.status === "completed" || r.status === "failed" || r.status === "killed")) {
      process.stdout.write(`── run ${r.status} · total $${r.total_cost_usd.toFixed(4)}\n`);
      break;
    }
  }
}

// Translate one SDK message (already JSON-parsed) into a human-readable line.
// Returns null to suppress (e.g. rate-limit heartbeats).
function renderTailLine(
  kind: string,
  payload: unknown,
  workdir: string,
): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  if (kind === "system") {
    const subtype = typeof p.subtype === "string" ? p.subtype : "";
    if (subtype === "init") {
      const sid = typeof p.session_id === "string" ? p.session_id.slice(0, 8) : "?";
      const model = typeof p.model === "string" ? p.model : "?";
      return `∙ session ${sid} · ${model}`;
    }
    return null;
  }

  if (kind === "rate_limit_event") return null;

  if (kind === "assistant") {
    const msg = (p.message ?? {}) as { content?: unknown[] };
    const lines: string[] = [];
    for (const c of msg.content ?? []) {
      if (!c || typeof c !== "object") continue;
      const cc = c as Record<string, unknown>;
      if (cc.type === "tool_use") {
        const name = typeof cc.name === "string" ? cc.name : "?";
        const summary = summarizeToolInput(name, cc.input, workdir);
        lines.push(`→ ${name}${summary ? " " + summary : ""}`);
      } else if (cc.type === "text") {
        const text = typeof cc.text === "string" ? cc.text.trim() : "";
        if (text) lines.push(`  │ ${text.length > 140 ? text.slice(0, 137) + "…" : text}`);
      }
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  if (kind === "user") {
    const msg = (p.message ?? {}) as { content?: unknown };
    const content = msg.content;
    if (!Array.isArray(content)) return null;
    const lines: string[] = [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const cc = c as Record<string, unknown>;
      if (cc.type === "tool_result") {
        const isError = Boolean(cc.is_error);
        if (isError) {
          const text = extractToolResultText(cc.content);
          lines.push(`  ✗ ${text.length > 100 ? text.slice(0, 97) + "…" : text}`);
        } else {
          lines.push(`  ✓`);
        }
      }
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  if (kind === "result") {
    const cost = typeof p.total_cost_usd === "number" ? p.total_cost_usd.toFixed(4) : "?";
    const ms = typeof p.duration_ms === "number" ? p.duration_ms : 0;
    const turns = typeof p.num_turns === "number" ? p.num_turns : 0;
    const subtype = typeof p.subtype === "string" ? p.subtype : "?";
    const marker = subtype === "success" ? "──" : "✗✗";
    return `${marker} ${subtype} · $${cost} · ${(ms / 1000).toFixed(1)}s · ${turns} turns`;
  }

  return null;
}

function summarizeToolInput(
  toolName: string,
  input: unknown,
  workdir: string,
): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const path =
    typeof i.file_path === "string"
      ? i.file_path
      : typeof i.path === "string"
        ? i.path
        : typeof i.notebook_path === "string"
          ? i.notebook_path
          : null;
  if (path) {
    const rel = path.startsWith(workdir) ? relative(workdir, path) || "." : path;
    return rel;
  }
  if (toolName === "Bash" && typeof i.command === "string") {
    const cmd = i.command.replace(/\s+/g, " ").trim();
    return cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
  }
  if (toolName === "Glob" && typeof i.pattern === "string") return i.pattern;
  if (toolName === "Grep" && typeof i.pattern === "string") return i.pattern;
  return "";
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === "object" && (c as Record<string, unknown>).type === "text") {
        const t = (c as Record<string, unknown>).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

async function cmdKill(argv: string[]) {
  const runId = argv[0];
  if (!runId) {
    console.error("df kill: run-id required");
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const store = openStore(config.root);
  const run = store.getRun(runId);
  if (!run) {
    console.error(`no run: ${runId}`);
    process.exitCode = 1;
    return;
  }
  const paths = runPaths(config.root, runId);
  await writeFile(paths.killed, `killed at ${new Date().toISOString()}\n`, "utf8");
  store.updateRun(runId, { status: "killed" });
  console.log(`kill sentinel written: ${paths.killed}`);
  console.log("worker will stop the run on its next tool call.");
}

function compactEvent(ts: number, stage: string, kind: string, payload: unknown): string {
  const t = new Date(ts).toISOString();
  const head = `[${t}] ${stage.padEnd(10)} ${kind}`;
  if (!payload) return head;
  if (typeof payload === "object" && payload !== null) {
    const p = payload as Record<string, unknown>;
    if (p.subtype || p.total_cost_usd || p.num_turns) {
      const cost = typeof p.total_cost_usd === "number" ? ` $${p.total_cost_usd.toFixed(4)}` : "";
      return `${head} ${p.subtype ?? ""}${cost}`;
    }
    if (typeof p.message === "string") return `${head} ${p.message.slice(0, 120)}`;
  }
  return head;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("df error:", err instanceof Error ? err.message : err);
  process.exit(1);
});

