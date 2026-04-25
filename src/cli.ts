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
  type RunRow,
  type StageRow,
  type StageStatus,
  type RunStatus,
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
import type { PipelineResult } from "./orchestrator/pipeline.js";

// --- Small presentation helpers ----------------------------------------

// Respect NO_COLOR + non-TTY. If stdout isn't a terminal, strip ANSI.
const COLOR_ENABLED = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ansi = (code: string) => (s: string) =>
  COLOR_ENABLED ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = ansi("1");
const dim = ansi("2");
const red = ansi("31");
const green = ansi("32");
const yellow = ansi("33");
const magenta = ansi("35");
const cyan = ansi("36");

function colorRunStatus(s: RunStatus): string {
  switch (s) {
    case "completed":
      return green(s);
    case "running":
      return yellow(s);
    case "failed":
    case "killed":
      return red(s);
    default:
      return s;
  }
}
function colorStageStatus(s: StageStatus): string {
  switch (s) {
    case "completed":
      return green(s);
    case "running":
      return yellow(s);
    case "failed":
      return red(s);
    case "skipped":
      return dim(s);
    default:
      return s;
  }
}

// Human-readable delta: "just now" / "42s ago" / "3m ago" / "2h ago" / "4d ago".
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "in the future";
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec === 0 ? `${min}m` : `${min}m${sec}s`;
}

// Variable-precision cost: "$0" for 0; "$0.0012" for tiny; "$1.35" normally.
function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// Render a matrix as a fixed-width table with auto-widths per column. The
// first row is treated as the header (no coloring of widths, but the header
// gets a dim/bold cue applied by the caller if it wants). Right-aligned
// indexes are provided via `alignRight`.
function renderTable(
  rows: string[][],
  opts: { alignRight?: Set<number>; gap?: string } = {},
): string {
  if (rows.length === 0) return "";
  const cols = rows[0]!.length;
  const widths = new Array(cols).fill(0);
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      widths[c] = Math.max(widths[c], visibleWidth(row[c] ?? ""));
    }
  }
  const gap = opts.gap ?? "  ";
  const align = opts.alignRight ?? new Set<number>();
  return rows
    .map((row) =>
      row
        .map((cell, c) => {
          const w = widths[c] - visibleWidth(cell ?? "");
          const pad = " ".repeat(Math.max(0, w));
          return align.has(c) ? pad + cell : cell + pad;
        })
        .join(gap)
        .trimEnd(),
    )
    .join("\n");
}

// ANSI-stripping width so colored cells still align.
function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Pretty-print a parsed JSON value with light syntax coloring (keys cyan,
// strings green, numbers yellow, booleans magenta, null dim). Falls back
// to plain indented JSON when color is off. Used by `mill tail -p` /
// `mill logs -p` to show the raw event payload in a readable form —
// complements --raw (NDJSON for scripts) and the default curated views.
function prettyJson(value: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
  if (body === undefined) return "undefined";
  if (!COLOR_ENABLED) return body;
  // Matches: (a) string literals, optionally followed by `:` (= key),
  // (b) numbers, (c) booleans / null. Same classic pattern Chrome
  // devtools uses — string values contain no unescaped quotes by
  // construction of JSON.stringify.
  return body.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      if (m.endsWith(":") || /":\s*$/.test(m)) return cyan(m);
      if (m.startsWith('"')) return green(m);
      if (m === "true" || m === "false") return magenta(m);
      if (m === "null") return dim(m);
      return yellow(m);
    },
  );
}

// Render one event as a compact header line plus a pretty-printed JSON
// body. Shared by `mill tail -p` and `mill logs -p`.
function renderPrettyEvent(args: {
  ts: number;
  stage: string;
  kind: string;
  payload: unknown;
}): string {
  const header = `${dim(`[${new Date(args.ts).toISOString()}]`)} ${bold(args.stage)} ${cyan(args.kind)}`;
  const body = prettyJson(args.payload);
  return `${header}\n${indent(body, "  ")}\n`;
}

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
      console.error(`${red("mill:")} ${err.message}`);
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
      `${red("mill:")} \`claude\` CLI not found on PATH.\n` +
        dim("install with:") + " npm i -g @anthropic-ai/claude-code",
    );
    process.exit(1);
  }
}

function printHelp() {
  const h = (s: string) => bold(s);
  const c = (s: string) => cyan(s);
  const d = (s: string) => dim(s);
  process.stdout.write(
    [
      `${bold("mill")} — a harness around the ${cyan("claude")} CLI`,
      "",
      h("Setup"),
      `  ${c("mill init")} [<name>]             create .mill/ at the git root`,
      `  ${c("mill onboard")} [--refresh]       profile the repo (auto-injected into prompts)`,
      "",
      h("Runs"),
      `  ${c("mill new")} (<requirement...> | --from <file>)`,
      `           [--mode new|edit|auto] [--stop-after spec|design|spec2tests]`,
      `           [--pr] [--detach] [--all-defaults]`,
      `    ${d("--mode auto")}         detects edit when the repo has committed source,`,
      `                        otherwise new (scaffolds into .mill/runs/<id>/workdir/)`,
      `    ${d("--stop-after <s>")}    halts after a named stage; resume with mill run <id>`,
      `    ${d("--pr")}                pushes the branch and opens a GitHub PR (edit only)`,
      `    ${d("--detach")}            queues the run; use mill worker to execute`,
      `    ${d("--all-defaults")}      accept every clarify default (no prompting)`,
      `  ${c("mill run")} <run-id>              resume a run, skipping completed stages`,
      `  ${c("mill kill")} <run-id>             write KILLED sentinel; next tool call aborts`,
      "",
      h("Observe"),
      `  ${c("mill status")} [<run-id>]         list recent runs, or stage breakdown of one`,
      `  ${c("mill tail")} <run-id> [-f] [-v]   human-readable activity stream (-v: full text + thinking + tool bodies)`,
      `  ${c("mill logs")} <run-id> [-f] [--raw]  events (--raw emits the raw stream-json as NDJSON)`,
      `  ${c("mill history")}                   print .mill/journal.md`,
      "",
      h("Findings"),
      `  ${c("mill findings")} [--all] [--limit N]        recurring findings across runs`,
      `  ${c("mill findings suppress")} <fp> [--note T]    hide a noisy fingerprint`,
      `  ${c("mill findings unsuppress")} <fp>             re-enable`,
      `  ${c("mill findings suppressed")}                   list suppressed fingerprints`,
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
  const marker = result.created ? green("✓") : dim("·");
  const verb = result.created ? "initialized" : "already initialized";
  console.log(`${marker} ${verb} mill project ${bold(result.info.name)}`);
  console.log(dim(`  ${result.projectRoot}`));
  if (result.gitignoreUpdated) {
    console.log(dim("  added /.mill/ to .gitignore"));
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
      "mill new: pass the requirement either positionally or via --from, not both",
    );
    process.exitCode = 2;
    return;
  }

  const rawMode = (values.mode ?? "auto").toLowerCase();
  if (rawMode !== "auto" && rawMode !== "new" && rawMode !== "edit") {
    console.error(`mill new: --mode must be auto|new|edit, got "${values.mode}"`);
    process.exitCode = 2;
    return;
  }

  let requirement: string;
  if (fromPath) {
    try {
      requirement = (await readFile(fromPath, "utf8")).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`mill new: could not read --from ${fromPath}: ${msg}`);
      process.exitCode = 2;
      return;
    }
  } else {
    requirement = positionalText;
  }

  if (!requirement) {
    console.error(
      fromPath
        ? `mill new: --from file ${fromPath} is empty`
        : "mill new: requirement is required",
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
    console.error("mill new: --pr requires edit mode");
    process.exitCode = 2;
    return;
  }

  if (rawMode === "auto") {
    console.log(`${dim("mode:")} ${effectiveMode} ${dim("(auto)")}`);
  } else {
    console.log(`${dim("mode:")} ${effectiveMode}`);
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
    console.error(`mill new: intake failed: ${msg}`);
    process.exitCode = 1;
    return;
  }
  const { runId, branch, baseBranch } = intakeResult;
  console.log(`${dim("run:")}  ${bold(runId)}`);
  if (effectiveMode === "edit" && branch) {
    const off = baseBranch ? ` ${dim(`(off ${baseBranch})`)}` : "";
    console.log(`${dim("branch:")} ${branch}${off}`);
  }

  const ctx = await buildContext({ runId, config, store });
  console.log(`\n${dim("▸")} asking clarifying questions…`);
  const clarifyRes = await clarify(ctx);
  if (!clarifyRes.ok) {
    console.error(red(`clarify failed: ${clarifyRes.error}`));
    process.exitCode = 1;
    return;
  }

  const clar = store.getClarifications(runId);
  if (!clar) throw new Error("clarifications not stored");

  console.log(`${dim("kind:")} ${clar.kind}`);
  const answers = await promptForAnswers(clar, Boolean(values["all-defaults"]));
  await recordAnswers(ctx, answers);
  console.log(dim("\nanswers recorded. run is now dark.\n"));

  if (values.detach) {
    console.log(dim("queued — launch `npm run worker` to execute."));
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
  const stageList = stopAfter
    ? stageChainUpTo(stopAfter)
    : "spec → design → implement ⇄ review → verify → deliver";
  console.log(`${dim("▸")} running pipeline: ${stageList}`);
  installInlineAbortHandler(ctx);
  const result = await runPipeline({
    runId,
    config,
    ctx,
    ...(stopAfter ? { stopAfter } : {}),
  });
  const paths = runPaths(config.root, runId);
  printPipelineOutcome(result, { store, paths, stopAfter });
}

function stageChainUpTo(stop: StopStage): string {
  const chain = ["spec", "design", "spec2tests"];
  const idx = chain.indexOf(stop);
  return chain.slice(0, idx + 1).join(" → ") + dim(" (then stop)");
}

function printPipelineOutcome(
  result: PipelineResult,
  opts: {
    store: ReturnType<typeof openStore>;
    paths: ReturnType<typeof runPaths>;
    stopAfter?: StopStage;
  },
) {
  const statusLabel =
    result.status === "completed"
      ? green("✓ completed")
      : result.status === "planned"
        ? cyan("◇ planned")
        : result.status === "killed"
          ? red("✗ killed")
          : red("✗ failed");
  console.log();
  console.log(
    `${statusLabel}  ${dim("·")}  ${fmtCost(result.costUsd)}  ${dim("·")}  ${fmtDurationMs(result.durationMs)}`,
  );
  if (result.reason) console.log(dim(`  reason: ${result.reason}`));

  // Compact per-stage breakdown — easier to scan than JSON.
  const stages = opts.store.listStages(result.runId);
  if (stages.length > 0) {
    console.log();
    const rows = stages.map((s) => [
      dim("·"),
      s.name,
      colorStageStatus(s.status),
      fmtCost(s.cost_usd),
      s.started_at ? dim(fmtStageDuration(s)) : dim("—"),
    ]);
    console.log(renderTable(rows, { alignRight: new Set([3]) }));
  }

  if (opts.stopAfter) {
    console.log();
    if (opts.stopAfter === "spec") {
      console.log(`${dim("spec:")} ${opts.paths.spec}`);
    } else {
      console.log(`${dim("spec:")}         ${opts.paths.spec}`);
      console.log(`${dim("architecture:")} ${opts.paths.architecture}`);
    }
    console.log(dim(`\nreview those files, then continue with:`));
    console.log(`  ${cyan(`mill run ${result.runId}`)}`);
  } else if (result.status === "completed") {
    console.log();
    console.log(`${dim("delivery:")} ${opts.paths.delivery}`);
    console.log(`${dim("workdir:")}  ${opts.paths.workdir}`);
  }
}

function fmtStageDuration(s: StageRow): string {
  if (!s.started_at) return "—";
  const end = s.finished_at ?? Date.now();
  return fmtDurationMs(end - s.started_at);
}

type StopStage = "spec" | "design" | "spec2tests";
const STOP_STAGES: StopStage[] = ["spec", "design", "spec2tests"];

function resolveStopAfter(raw: string | undefined): StopStage | undefined | "error" {
  const v = raw?.trim();
  if (!v) return undefined;
  if (!STOP_STAGES.includes(v as StopStage)) {
    console.error(
      `mill new: --stop-after must be one of ${STOP_STAGES.join("|")}, got "${v}"`,
    );
    return "error";
  }
  return v as StopStage;
}

async function cmdRun(argv: string[]) {
  const runId = argv[0];
  if (!runId) {
    console.error("mill run: run-id required");
    process.exitCode = 2;
    return;
  }
  preflightClaude();
  const config = loadConfig();
  const store = openStore(config.root);
  const run = store.getRun(runId);
  if (!run) {
    console.error(red(`no run: ${runId}`));
    process.exitCode = 1;
    return;
  }
  if (run.status === "completed") {
    console.log(`${green("✓")} ${bold(runId)} ${dim("already completed; nothing to do")}`);
    return;
  }
  if (run.status === "killed") {
    console.log(`${red("✗")} ${bold(runId)} ${dim("is killed; remove runs/<id>/KILLED to retry")}`);
    return;
  }
  const ctx = await buildContext({ runId, config, store });
  console.log(`${dim("▸")} resuming ${bold(runId)} ${dim(`(was ${run.status})`)}`);
  // Flip status back to running so observers (`mill tail -f`, `mill logs -f`,
  // future web UI) don't see the prior terminal status and exit their
  // follow loops immediately. Pipeline stages update to completed/failed
  // at their natural boundaries.
  if (run.status !== "running") {
    store.updateRun(runId, { status: "running" });
  }
  installInlineAbortHandler(ctx);
  const result = await runPipeline({ runId, config, ctx });
  const paths = runPaths(config.root, runId);
  printPipelineOutcome(result, { store, paths });
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
    const n = clar.questions.length;
    for (const [i, q] of clar.questions.entries()) {
      const counter = dim(`(${i + 1}/${n})`);
      process.stdout.write(`\n${counter} ${bold(q.question)}\n`);
      process.stdout.write(`${dim("why:")} ${dim(q.why)}\n`);
      if (q.default) {
        process.stdout.write(`${dim("default:")} ${q.default}\n`);
      }
      const raw = (await rl.question(`${cyan("›")} `)).trim();
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
    dim(
      refresh
        ? "▸ refreshing profile (reading repo, calling claude)…"
        : "▸ checking for existing profile…",
    ),
  );
  const result = await onboard({ refresh });
  if (result.cached) {
    console.log(dim("profile already exists. Run `mill onboard --refresh` to rebuild."));
    return;
  }
  const config = loadConfig();
  console.log(`${green("✓")} profile written`);
  console.log(dim(`  ${config.root}/.mill/profile.md`));
  console.log(
    `  ${dim("cost:")} ${fmtCost(result.costUsd)}  ${dim("·")}  ${dim("duration:")} ${fmtDurationMs(result.durationMs)}`,
  );
  console.log(`  ${dim("stack:")} ${result.profile.stack}`);
  const cmds = result.profile.commands;
  const present = (label: string, v: string | null) =>
    v ? `  ${dim(label + ":")} ${v}` : `  ${dim(label + ":")} ${dim("(none detected)")}`;
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
      console.error(`mill findings ${sub}: fingerprint required`);
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
      console.log(`${green("✓")} suppressed ${dim(fp)}`);
    } else {
      store.unsuppressFingerprint(fp);
      console.log(`${green("✓")} unsuppressed ${dim(fp)}`);
    }
    return;
  }
  if (sub === "suppressed") {
    const config = loadConfig();
    const store = openStore(config.root);
    const rows = store.listSuppressedFingerprints();
    if (rows.length === 0) {
      console.log(dim("(none)"));
      return;
    }
    const table: string[][] = [
      [dim("added"), dim("fingerprint"), dim("note")],
    ];
    for (const r of rows) {
      table.push([dim(relTime(r.added_at)), r.fingerprint, r.note ?? ""]);
    }
    console.log(renderTable(table));
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
    console.log(
      dim(
        values.all
          ? "(no findings on record)"
          : "(no recurring findings — use --all to see singletons)",
      ),
    );
    return;
  }
  const colorSeverity = (s: string) => {
    if (s === "CRITICAL") return red(bold(s));
    if (s === "HIGH") return red(s);
    if (s === "MEDIUM") return yellow(s);
    return dim(s);
  };
  const header = [dim("runs"), dim("sev"), dim("critic"), dim("last"), dim("title")];
  const table: string[][] = [header];
  for (const e of entries) {
    const title = e.suppressed ? `${e.title} ${dim("(suppressed)")}` : e.title;
    table.push([
      String(e.runCount),
      colorSeverity(e.severity),
      e.critic,
      dim(relTime(e.lastSeen)),
      title,
    ]);
  }
  console.log(renderTable(table, { alignRight: new Set([0]) }));
  console.log();
  for (const e of entries) {
    console.log(`  ${dim("fp")} ${dim(e.fingerprint)}`);
    if (e.exampleDetailPath) console.log(`     ${dim("↳ " + e.exampleDetailPath)}`);
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
      console.log(`${dim("project:")} ${bold(info.name)} ${dim(config.root)}`);
      console.log();
    }
    const rows = store.listRuns({ limit: 20 });
    if (rows.length === 0) {
      console.log(dim("(no runs yet — try `mill new \"...\"`)"));
      return;
    }
    const header = [
      dim("id"),
      dim("status"),
      dim("mode"),
      dim("kind"),
      dim("cost"),
      dim("created"),
    ];
    const table = [header];
    for (const r of rows) {
      table.push([
        r.id,
        colorRunStatus(r.status),
        r.mode ?? "new",
        r.kind ?? dim("—"),
        fmtCost(r.total_cost_usd),
        dim(relTime(r.created_at)),
      ]);
    }
    console.log(renderTable(table, { alignRight: new Set([4]) }));
    return;
  }
  const run = store.getRun(runId);
  if (!run) {
    console.error(red(`no run: ${runId}`));
    process.exitCode = 1;
    return;
  }
  const stages = store.listStages(runId);
  renderRunHeader(run);
  console.log();
  renderStageTable(stages);
}

function renderRunHeader(run: RunRow) {
  const runTokens = totalTokens(run);
  console.log(`${bold("run")} ${bold(run.id)}`);
  const rows: string[][] = [
    [dim("  status"), colorRunStatus(run.status)],
    [dim("  mode"), run.mode ?? "new"],
    [dim("  kind"), run.kind ?? "—"],
    [dim("  cost"), fmtCost(run.total_cost_usd)],
    [
      dim("  tokens"),
      `${fmtTokens(run.total_input_tokens, run.total_cache_creation_tokens, run.total_cache_read_tokens, run.total_output_tokens)} ${dim(`(total ${runTokens.toLocaleString()})`)}`,
    ],
    [dim("  created"), dim(relTime(run.created_at))],
  ];
  console.log(renderTable(rows));
}

function renderStageTable(stages: StageRow[]) {
  if (stages.length === 0) {
    console.log(dim("(no stages yet)"));
    return;
  }
  const header = [
    dim("stage"),
    dim("status"),
    dim("cost"),
    dim("in"),
    dim("cc"),
    dim("cr"),
    dim("out"),
    dim("elapsed"),
    dim("started"),
  ];
  const rows = stages.map((s) => [
    s.name,
    colorStageStatus(s.status),
    fmtCost(s.cost_usd),
    compactTokens(s.input_tokens),
    compactTokens(s.cache_creation_tokens),
    compactTokens(s.cache_read_tokens),
    compactTokens(s.output_tokens),
    s.started_at ? dim(fmtStageDuration(s)) : dim("—"),
    s.started_at ? dim(relTime(s.started_at)) : dim("—"),
  ]);
  console.log(
    renderTable([header, ...rows], {
      alignRight: new Set([2, 3, 4, 5, 6, 7]),
    }),
  );
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
      // --raw / --json emit the unmodified payload JSON per line (NDJSON),
      // i.e. exactly what the `claude` subprocess streamed. Useful for
      // piping into jq or diffing across runs.
      raw: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      after: { type: "string" },
      limit: { type: "string", default: "200" },
    },
  });
  const runId = positionals[0];
  if (!runId) {
    console.error("mill logs: run-id required");
    process.exitCode = 2;
    return;
  }
  const raw = Boolean(values.raw || values.json);
  const config = loadConfig();
  const store = openStore(config.root);
  let after = values.after ? Number(values.after) : 0;
  const limit = Number(values.limit ?? "200");

  const dump = () => {
    const events = store.tailEvents(runId, after, limit);
    for (const e of events) {
      if (raw) {
        // payload_json is the stream-json line from the `claude` subprocess,
        // wrapped as-is. Emit it verbatim so downstream jq parses it.
        process.stdout.write(e.payload_json + "\n");
      } else {
        const payload = safeParse(e.payload_json);
        const line = compactEvent(e.ts, e.stage, e.kind, payload);
        console.log(line);
      }
      after = e.id;
    }
  };

  dump();
  if (!values.follow) return;

  // Poll every second until the process is interrupted. Only exit when
  // we've seen two consecutive "terminal & no new events" reads — this
  // tolerates starting against a stale terminal status while a resume
  // is spinning up (cmdRun flips status to running, but there's a race).
  let quietTicks = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(1000);
    const run = store.getRun(runId);
    const before = after;
    dump();
    const gotEvents = after !== before;
    const terminal =
      !!run && (run.status === "completed" || run.status === "failed" || run.status === "killed");
    if (terminal && !gotEvents) {
      if (++quietTicks >= 2) break;
    } else {
      quietTicks = 0;
    }
  }
}

async function cmdTail(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      follow: { type: "boolean", short: "f", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      after: { type: "string" },
    },
  });
  const tailOpts: TailOpts = { verbose: Boolean(values.verbose) };
  const runId = positionals[0];
  if (!runId) {
    console.error("mill tail: run-id required");
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
        process.stdout.write(`\n${dim("──")} ${bold(e.stage)} ${dim("──")}\n`);
        lastStage = e.stage;
      }
      const payload = safeParse(e.payload_json);
      const line = renderTailLine(e.kind, payload, paths.workdir, tailOpts);
      if (line !== null) process.stdout.write(line + "\n");
      after = e.id;
    }
  };

  dump();
  if (!values.follow) return;

  // Only exit when we've seen two consecutive "terminal & no new events"
  // reads — tolerates starting against a stale terminal status while a
  // resume is spinning up.
  let quietTicks = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(1000);
    const r = store.getRun(runId);
    const before = after;
    dump();
    const gotEvents = after !== before;
    const terminal =
      !!r && (r.status === "completed" || r.status === "failed" || r.status === "killed");
    if (terminal && !gotEvents) {
      if (++quietTicks >= 2) {
        const marker = r.status === "completed" ? green("✓") : red("✗");
        process.stdout.write(
          `\n${marker} run ${colorRunStatus(r.status)}  ${dim("·")}  total ${fmtCost(r.total_cost_usd)}\n`,
        );
        break;
      }
    } else {
      quietTicks = 0;
    }
  }
}

interface TailOpts {
  // Verbose mode shows the model's text in full (no 140-char clip),
  // includes thinking blocks, prints full tool inputs/results. Default
  // off because the unabridged stream is noisy during long implement
  // stages; -v on demand is usually what you want.
  verbose: boolean;
}

// Translate one SDK message (already JSON-parsed) into a human-readable line.
// Returns null to suppress (e.g. rate-limit heartbeats).
function renderTailLine(
  kind: string,
  payload: unknown,
  workdir: string,
  opts: TailOpts = { verbose: false },
): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  if (kind === "system") {
    const subtype = typeof p.subtype === "string" ? p.subtype : "";
    if (subtype === "init") {
      const sid = typeof p.session_id === "string" ? p.session_id.slice(0, 8) : "?";
      const model = typeof p.model === "string" ? p.model : "?";
      return dim(`∙ session ${sid} · ${model}`);
    }
    return null;
  }

  if (kind === "rate_limit_event") return null;

  if (kind === "remediation") {
    const status = typeof p.status === "string" ? p.status : "?";
    const label = typeof p.label === "string" ? p.label : "";
    const attempt = typeof p.attempt === "number" ? p.attempt : 0;
    const color =
      status === "recovered" ? green : status === "exhausted" ? red : yellow;
    return `  ${color("↻")} ${dim(`retry ${attempt} · ${label}`)} ${color(status)}`;
  }

  if (kind === "assistant") {
    const msg = (p.message ?? {}) as { content?: unknown[] };
    const lines: string[] = [];
    for (const c of msg.content ?? []) {
      if (!c || typeof c !== "object") continue;
      const cc = c as Record<string, unknown>;
      if (cc.type === "tool_use") {
        const name = typeof cc.name === "string" ? cc.name : "?";
        if (opts.verbose) {
          lines.push(`${cyan("→")} ${name}`);
          const body = formatToolInputFull(cc.input, workdir);
          if (body) lines.push(indent(body, "    "));
        } else {
          const summary = summarizeToolInput(name, cc.input, workdir);
          lines.push(`${cyan("→")} ${name}${summary ? " " + dim(summary) : ""}`);
        }
      } else if (cc.type === "text") {
        const text = typeof cc.text === "string" ? cc.text.trim() : "";
        if (!text) continue;
        if (opts.verbose) {
          lines.push(indent(text, `  ${dim("│")} `));
        } else {
          const clipped = text.length > 140 ? text.slice(0, 137) + "…" : text;
          lines.push(dim(`  │ ${clipped}`));
        }
      } else if (cc.type === "thinking") {
        // Only surface thinking in verbose — it's long and rarely worth
        // reading at a glance.
        if (!opts.verbose) continue;
        const text = typeof cc.thinking === "string" ? cc.thinking.trim() : "";
        if (text) lines.push(indent(text, `  ${dim("~")} `));
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
        const text = extractToolResultText(cc.content, opts.verbose);
        const capped =
          opts.verbose && text.length > 4000
            ? text.slice(0, 4000) + `\n… [truncated ${text.length - 4000} chars]`
            : text;
        if (isError) {
          if (opts.verbose && text) {
            lines.push(`  ${red("✗")}`);
            lines.push(indent(capped, "    "));
          } else {
            const clipped = text.length > 100 ? text.slice(0, 97) + "…" : text;
            lines.push(`  ${red("✗")} ${red(clipped)}`);
          }
        } else if (opts.verbose && text) {
          lines.push(`  ${dim(green("✓"))}`);
          lines.push(indent(capped, `    ${dim("│")} `));
        } else {
          lines.push(`  ${dim(green("✓"))}`);
        }
      }
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  if (kind === "result") {
    const cost = typeof p.total_cost_usd === "number" ? p.total_cost_usd : 0;
    const ms = typeof p.duration_ms === "number" ? p.duration_ms : 0;
    const turns = typeof p.num_turns === "number" ? p.num_turns : 0;
    const subtype = typeof p.subtype === "string" ? p.subtype : "?";
    const ok = subtype === "success";
    const label = ok ? green(`✓ ${subtype}`) : red(`✗ ${subtype}`);
    return `${dim("──")} ${label}  ${dim("·")}  ${fmtCost(cost)}  ${dim("·")}  ${fmtDurationMs(ms)}  ${dim("·")}  ${turns} ${dim("turns")}`;
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

function extractToolResultText(content: unknown, preserveWhitespace = false): string {
  const norm = (s: string) =>
    preserveWhitespace ? s.replace(/\s+$/g, "") : s.replace(/\s+/g, " ").trim();
  if (typeof content === "string") return norm(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === "object" && (c as Record<string, unknown>).type === "text") {
        const t = (c as Record<string, unknown>).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return preserveWhitespace
      ? parts.join("\n").replace(/\s+$/g, "")
      : parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

// Prefix every line of `text` with `prefix`. Used in verbose tail to keep
// multi-line assistant text / tool results visually grouped under the
// event they belong to.
function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

// Verbose tool-input formatter. For the tools we know (Read/Write/Edit/
// Bash/Glob/Grep) emit the human-meaningful field(s); fall back to
// pretty-printed JSON for everything else. Long content (file bodies
// inside Write.content, large strings) gets soft-capped so one mega
// event doesn't flood the terminal.
function formatToolInputFull(input: unknown, workdir: string): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const rel = (p: string) =>
    p.startsWith(workdir) ? relative(workdir, p) || "." : p;
  const cap = (s: string, n = 4000) =>
    s.length > n ? s.slice(0, n) + `\n… [truncated ${s.length - n} chars]` : s;

  const lines: string[] = [];
  const pushKV = (k: string, v: string) => lines.push(`${dim(k + ":")} ${v}`);

  if (typeof i.file_path === "string") pushKV("path", rel(i.file_path));
  if (typeof i.notebook_path === "string") pushKV("notebook", rel(i.notebook_path));
  if (typeof i.command === "string") pushKV("command", i.command);
  if (typeof i.pattern === "string") pushKV("pattern", i.pattern);
  if (typeof i.old_string === "string") pushKV("old", cap(i.old_string, 600));
  if (typeof i.new_string === "string") pushKV("new", cap(i.new_string, 600));
  if (typeof i.content === "string") pushKV("content", cap(i.content));
  if (typeof i.prompt === "string") pushKV("prompt", cap(i.prompt, 600));

  if (lines.length > 0) return lines.join("\n");
  // Unknown tool shape — dump JSON.
  try {
    return cap(JSON.stringify(i, null, 2));
  } catch {
    return "";
  }
}

async function cmdKill(argv: string[]) {
  const runId = argv[0];
  if (!runId) {
    console.error("mill kill: run-id required");
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
  console.log(`${red("✗")} kill sentinel written for ${bold(runId)}`);
  console.log(dim(`  ${paths.killed}`));
  console.log(dim("  run stops on the next tool call inside the claude subprocess."));
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
  console.error(`${red("mill error:")} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

