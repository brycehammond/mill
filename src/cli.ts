#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { execFileSync, spawn } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openStore,
  runPaths,
  readJournal,
  journalPath,
  daemonPidPath,
  daemonPortPath,
  centralDbPath,
  detectRunMode,
  resolveProjectFromCwd,
  resolveProjectByIdentifier,
  projectStateDir,
  atLeast,
  type Clarifications,
  type DisplayStageRow,
  type ProjectRow,
  type RunMode,
  type RunRow,
  type StageRow,
  type StageStatus,
  type StateStore,
  type RunStatus,
} from "./core/index.js";
import {
  loadConfig,
  NoProjectError,
  onboard,
} from "./orchestrator/index.js";
import { DaemonClient, DaemonNotRunningError } from "./cli/client.js";

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
    case "paused_budget":
    case "awaiting_approval":
      return cyan(s);
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

// Render a matrix as a fixed-width table with auto-widths per column.
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

// Top-level commands. Subcommand trees (`project`, `daemon`, `auth`)
// dispatch inside their own handlers.
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
  | "project"
  | "daemon"
  | "auth"
  | "approve"
  | "reject"
  | "resume"
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
        return await cmdHistory(rest);
      case "onboard":
        return await cmdOnboard(rest);
      case "findings":
        return await cmdFindings(rest);
      case "project":
        return await cmdProject(rest);
      case "daemon":
        return await cmdDaemon(rest);
      case "auth":
        return await cmdAuth(rest);
      case "approve":
        return await cmdApprove(rest);
      case "reject":
        return await cmdReject(rest);
      case "resume":
        return await cmdResume(rest);
      case "help":
      default:
        printHelp();
        return;
    }
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      console.error(`${red("mill:")} ${err.message}`);
      process.exitCode = 1;
      return;
    }
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
      h("Daemon"),
      `  ${c("mill daemon start")} [--port N] [--host H] [--foreground]   start the daemon`,
      `  ${c("                  ")} [--bind loopback|lan|all] [--insecure] [--cert P --key P]`,
      `  ${c("mill daemon stop")}                                          stop the daemon (SIGTERM, drains)`,
      `  ${c("mill daemon status")}                                        running on host:port (pid)`,
      "",
      h("Auth"),
      `  ${c("mill auth init")}                       generate a token at ~/.mill/auth.token`,
      `  ${c("mill auth show")}                       print the configured token`,
      `  ${c("mill auth rotate")}                     replace the token; invalidates UI sessions`,
      "",
      h("Projects"),
      `  ${c("mill project add")} [<path>]            register a git repo (default: cwd)`,
      `  ${c("mill project ls")}                      list projects + cost rollup`,
      `  ${c("mill project show")} <id>               detailed view of one project`,
      `  ${c("mill project rm")} <id> [--yes]         deregister (history kept)`,
      `  ${c("mill init")}                            ${d("[deprecated alias for `mill project add`]")}`,
      `  ${c("mill onboard")} [--refresh]             profile the repo (auto-injected into prompts)`,
      "",
      h("Runs"),
      `  ${c("mill new")} (<requirement...> | --from <file>) [--project <id>]`,
      `           [--mode new|edit|auto] [--stop-after spec|design|spec2tests]`,
      `           [--detach] [--all-defaults]`,
      `    ${d("--mode auto")}         detects edit when the repo has committed source,`,
      `                        otherwise new`,
      `    ${d("--stop-after <s>")}    halts after a named stage; resume with mill run <id>`,
      `    ${d("--detach")}            queues the run; daemon picks it up`,
      `    ${d("--all-defaults")}      accept every clarify default (no prompting)`,
      `  ${c("mill run")} <run-id>              resume a run, skipping completed stages`,
      `  ${c("mill kill")} <run-id>             write KILLED sentinel; next tool call aborts`,
      "",
      h("Observe"),
      `  ${c("mill status")} [<run-id>]         list recent runs, or stage breakdown of one`,
      `  ${c("mill tail")} <run-id> [-f] [-v]   human-readable activity stream (-v: full text + thinking + tool bodies)`,
      `  ${c("mill logs")} <run-id> [-f] [--raw]  events (--raw emits the raw stream-json as NDJSON)`,
      `  ${c("mill history")} [--project <id>]  print the project journal`,
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

// ---------- shared helpers (used by both daemon-routed and direct paths) ----------

// Open the central DB. Read commands use this so they keep working
// when the daemon is down (AC-8). Mutating commands route through the
// daemon to avoid a second writer racing on SQLite.
function openCentralStoreReadOnly(): StateStore {
  const dbPath = centralDbPath();
  // mkdir the parent so openStore doesn't choke on a fresh install.
  mkdirSync(dirname(dbPath), { recursive: true });
  return openStore(dbPath);
}

// Resolve a project for a read command. Honors `--project <id|name|path>`
// first, then walks up from cwd. Returns null when nothing matches —
// reads are allowed to operate without a project (e.g. `mill status`
// with no runs registered yet should print "(no runs)" rather than
// failing).
function resolveProjectForRead(
  store: StateStore,
  ident: string | undefined,
): ProjectRow | null {
  if (ident && ident.trim()) {
    const p = resolveProjectByIdentifier(store, ident.trim());
    return p ?? null;
  }
  return resolveProjectFromCwd(store, process.cwd());
}

// Strict variant for mutating commands: surface a clear error when no
// project resolves so the user knows what to fix (AC-3).
function requireProjectForMutate(
  store: StateStore,
  ident: string | undefined,
): ProjectRow {
  const p = resolveProjectForRead(store, ident);
  if (!p) {
    throw new NoProjectError(
      "no project resolved from cwd. Use `mill project add` or pass --project <id|name|path>.",
    );
  }
  if (p.removed_at !== null) {
    throw new Error(
      `project ${p.id} is removed. Re-register it with \`mill project add ${p.root_path}\`.`,
    );
  }
  return p;
}

// ---------- mill init (deprecation alias) ----------

async function cmdInit(argv: string[]) {
  console.error(
    `${dim("note:")} \`mill init\` is deprecated; use \`mill project add\``,
  );
  return await projectAdd(argv);
}

// ---------- mill project ----------

async function cmdProject(argv: string[]) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add":
      return await projectAdd(rest);
    case "ls":
    case "list":
      return await projectLs(rest);
    case "show":
      return await projectShow(rest);
    case "rm":
    case "remove":
      return await projectRm(rest);
    case "gates":
      return await projectGates(rest);
    case "webhooks":
      return await projectWebhooks(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      printProjectHelp();
      return;
    default:
      console.error(`mill project: unknown subcommand "${sub}"`);
      printProjectHelp();
      process.exitCode = 2;
  }
}

async function projectGates(argv: string[]) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "set":
      return await projectGatesSet(rest);
    case "clear":
      return await projectGatesClear(rest);
    case "ls":
    case "list":
    case undefined:
      return await projectGatesLs(rest);
    default:
      console.error(`mill project gates: unknown subcommand "${sub}"`);
      console.error(
        `  usage: mill project gates set <project> <stage[,stage...]>`,
      );
      console.error(`         mill project gates clear <project>`);
      console.error(`         mill project gates ls <project>`);
      process.exitCode = 2;
  }
}

async function projectGatesLs(argv: string[]) {
  const ident = argv[0];
  if (!ident) {
    console.error("mill project gates ls: project required");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  const project = await client.getProject(ident);
  const out = await client.getProjectGates(project.id);
  if (out.stages.length === 0) {
    console.log(dim(`no approval gates set for ${project.name}`));
    return;
  }
  console.log(`${bold("approval gates")} for ${project.name}:`);
  for (const s of out.stages) {
    console.log(`  ${cyan(s)}`);
  }
}

async function projectGatesSet(argv: string[]) {
  const ident = argv[0];
  const stagesArg = argv[1];
  if (!ident || !stagesArg) {
    console.error(
      "mill project gates set: usage: mill project gates set <project> <stage[,stage...]>",
    );
    process.exitCode = 2;
    return;
  }
  const stages = stagesArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (stages.length === 0) {
    console.error("mill project gates set: at least one stage is required");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  const project = await client.getProject(ident);
  const out = await client.setProjectGates(project.id, stages);
  console.log(
    `${green("✓")} approval gates updated for ${bold(project.name)}: ${
      out.stages.join(", ") || dim("(none)")
    }`,
  );
}

async function projectGatesClear(argv: string[]) {
  const ident = argv[0];
  if (!ident) {
    console.error("mill project gates clear: project required");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  const project = await client.getProject(ident);
  await client.clearProjectGates(project.id);
  console.log(`${green("✓")} cleared approval gates for ${bold(project.name)}`);
}

async function projectWebhooks(argv: string[]) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add":
      return await projectWebhooksAdd(rest);
    case "ls":
    case "list":
      return await projectWebhooksLs(rest);
    case "rm":
    case "remove":
      return await projectWebhooksRm(rest);
    default:
      console.error(`mill project webhooks: unknown subcommand "${sub ?? ""}"`);
      console.error(
        "  usage: mill project webhooks add <project> --url <url> --events <list> --secret <token>",
      );
      console.error("         mill project webhooks ls <project>");
      console.error("         mill project webhooks rm <id>");
      process.exitCode = 2;
  }
}

async function projectWebhooksAdd(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      events: { type: "string" },
      secret: { type: "string" },
    },
  });
  const ident = positionals[0];
  if (!ident) {
    console.error(
      "mill project webhooks add: usage: mill project webhooks add <project> --url <url> --events <list> --secret <token>",
    );
    process.exitCode = 2;
    return;
  }
  if (!values.url) {
    console.error("mill project webhooks add: --url is required");
    process.exitCode = 2;
    return;
  }
  if (!values.events) {
    console.error("mill project webhooks add: --events is required");
    process.exitCode = 2;
    return;
  }
  if (!values.secret) {
    console.error("mill project webhooks add: --secret is required");
    process.exitCode = 2;
    return;
  }
  const events = values.events
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (events.length === 0) {
    console.error("mill project webhooks add: --events must list at least one event");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  const project = await client.getProject(ident);
  const out = await client.createWebhook(project.id, {
    url: values.url,
    events,
    secret: values.secret,
  });
  console.log(
    `${green("✓")} added webhook for ${bold(project.name)} ${dim(`(${out.id})`)}`,
  );
  console.log(`  ${dim("url:")}    ${out.url}`);
  console.log(`  ${dim("events:")} ${out.events.join(", ")}`);
}

async function projectWebhooksLs(argv: string[]) {
  const ident = argv[0];
  if (!ident) {
    console.error("mill project webhooks ls: project required");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  const project = await client.getProject(ident);
  const entries = await client.listWebhooks(project.id);
  if (entries.length === 0) {
    console.log(dim(`no webhooks configured for ${project.name}`));
    return;
  }
  const header = [
    dim("id"),
    dim("url"),
    dim("events"),
    dim("enabled"),
    dim("fails"),
  ];
  const rows = entries.map((e) => [
    e.id,
    e.url,
    e.events.join(","),
    e.enabled ? green("yes") : red("no"),
    String(e.consecutive_failures),
  ]);
  console.log(renderTable([header, ...rows], { alignRight: new Set([4]) }));
}

async function projectWebhooksRm(argv: string[]) {
  const id = argv[0];
  if (!id) {
    console.error("mill project webhooks rm: webhook id required");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  await client.deleteWebhook(id);
  console.log(`${green("✓")} removed webhook ${bold(id)}`);
}

function printProjectHelp() {
  console.log(
    [
      `${bold("mill project")} — manage registered repos`,
      ``,
      `  ${cyan("mill project add")} [<path>] [--name N]      register a git repo`,
      `  ${cyan("mill project ls")}  [--all]                  list projects + cost rollup`,
      `  ${cyan("mill project show")} <id>                    detailed view of one project`,
      `  ${cyan("mill project rm")} <id> [--yes]              deregister (history kept)`,
      `  ${cyan("mill project gates")} {set|clear|ls} <project>  approval gates per stage`,
      `  ${cyan("mill project webhooks")} {add|ls|rm} ...        outbound webhook subscriptions`,
    ].join("\n"),
  );
}

async function projectAdd(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
    },
  });
  const path = positionals[0] ?? process.cwd();
  const absPath = resolve(path);
  const client = new DaemonClient();
  const body: { root_path: string; name?: string } = { root_path: absPath };
  if (values.name) body.name = values.name;
  const out = await client.createProject(body);
  const marker = out.created ? green("✓") : dim("·");
  const verb = out.created ? "registered" : "already registered";
  console.log(`${marker} ${verb} project ${bold(out.project.name)}`);
  console.log(`  ${dim("id:")}   ${out.project.id}`);
  console.log(`  ${dim("path:")} ${out.project.root_path}`);
  if (out.migration) {
    const m = out.migration;
    if (m.runs_imported > 0 || m.events_imported > 0 || m.findings_imported > 0) {
      console.log(
        dim(
          `  migrated ${m.runs_imported} run(s), ${m.events_imported} event(s), ${m.findings_imported} finding(s)`,
        ),
      );
    }
    if (m.legacy_db_renamed_to) {
      console.log(dim(`  legacy db moved to ${m.legacy_db_renamed_to}`));
    }
  }
}

async function projectLs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      all: { type: "boolean", default: false },
    },
  });
  const client = new DaemonClient();
  // AC-8: `project ls` must work with the daemon down. We fall back to
  // a direct DB read, omitting cost rollups, only on
  // DaemonNotRunningError; other failures surface to the user.
  let entries;
  let staleWarning = false;
  try {
    entries = await client.listProjects({ includeRemoved: values.all });
  } catch (err) {
    if (!(err instanceof DaemonNotRunningError)) throw err;
    entries = projectsFromDbDirect({ includeRemoved: values.all });
    staleWarning = true;
  }
  if (entries.length === 0) {
    console.log(dim("(no projects registered — try `mill project add`)"));
    return;
  }
  if (staleWarning) {
    console.log(
      dim(
        "  daemon not running — showing registry only (cost rollups omitted).",
      ),
    );
  }
  const header = [
    dim("id"),
    dim("name"),
    dim("path"),
    dim("today"),
    dim("MTD"),
    dim("in-flight"),
    dim("last delivered"),
  ];
  const rows = entries.map((e) => [
    e.id,
    e.name,
    e.root_path,
    fmtCost(e.cost_today_usd ?? 0),
    fmtCost(e.cost_mtd_usd ?? 0),
    String(e.in_flight_runs ?? 0),
    e.last_delivery_ts ? dim(relTime(e.last_delivery_ts)) : dim("—"),
  ]);
  console.log(renderTable([header, ...rows], { alignRight: new Set([3, 4, 5]) }));
}

// Stale-rollup fallback for `project ls` when the daemon is down. Reads
// the central DB directly and omits cost rollups; the table still shows
// id/name/path so the user can confirm what's registered.
function projectsFromDbDirect(opts: { includeRemoved: boolean }): {
  id: string;
  name: string;
  root_path: string;
  cost_today_usd: number;
  cost_mtd_usd: number;
  in_flight_runs: number;
  last_delivery_ts: number | null;
}[] {
  const store = openCentralStoreReadOnly();
  try {
    const rows = store.listProjects({ includeRemoved: opts.includeRemoved });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      root_path: p.root_path,
      cost_today_usd: 0,
      cost_mtd_usd: 0,
      in_flight_runs: 0,
      last_delivery_ts: null,
    }));
  } finally {
    store.close();
  }
}

async function projectShow(argv: string[]) {
  const id = argv[0];
  if (!id) {
    console.error("mill project show: project id required");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  const e = await client.getProject(id);
  console.log(`${bold("project")} ${bold(e.name)} ${dim(e.id)}`);
  const rows: string[][] = [
    [dim("  path"), e.root_path],
    [dim("  added"), dim(relTime(e.added_at))],
    [dim("  today"), fmtCost(e.cost_today_usd)],
    [dim("  MTD"), fmtCost(e.cost_mtd_usd)],
    [dim("  in-flight"), String(e.in_flight_runs)],
    [
      dim("  last delivered"),
      e.last_delivery_ts ? dim(relTime(e.last_delivery_ts)) : dim("—"),
    ],
  ];
  if (e.removed_at !== null) {
    rows.push([dim("  removed"), red(relTime(e.removed_at))]);
  }
  if (e.monthly_budget_usd !== null) {
    rows.push([dim("  budget"), fmtCost(e.monthly_budget_usd)]);
  }
  if (e.default_concurrency !== null) {
    rows.push([dim("  concurrency"), String(e.default_concurrency)]);
  }
  console.log(renderTable(rows));
  console.log();
  console.log(`${dim("  state dir:")} ${projectStateDir(e.id)}`);
}

async function projectRm(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { yes: { type: "boolean", default: false } },
  });
  const id = positionals[0];
  if (!id) {
    console.error("mill project rm: project id required");
    process.exitCode = 2;
    return;
  }
  if (!values.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = (
        await rl.question(`Remove project ${bold(id)}? [y/N] `)
      ).trim().toLowerCase();
      if (ans !== "y" && ans !== "yes") {
        console.log(dim("aborted"));
        return;
      }
    } finally {
      rl.close();
    }
  }
  const client = new DaemonClient();
  await client.deleteProject(id);
  console.log(`${green("✓")} removed ${bold(id)} ${dim("(history kept)")}`);
}

// ---------- mill daemon ----------

async function cmdDaemon(argv: string[]) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "start":
      return await daemonStart(rest);
    case "stop":
      return await daemonStop(rest);
    case "status":
      return await daemonStatus(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      printDaemonHelp();
      return;
    default:
      console.error(`mill daemon: unknown subcommand "${sub}"`);
      printDaemonHelp();
      process.exitCode = 2;
  }
}

function printDaemonHelp() {
  console.log(
    [
      `${bold("mill daemon")} — long-running run-execution server`,
      ``,
      `  ${cyan("mill daemon start")} [--port N] [--host H] [--foreground] [--no-ui] [--open]   start (defaults to detached)`,
      `  ${cyan("mill daemon stop")}                                          SIGTERM, drains in-flight runs`,
      `  ${cyan("mill daemon status")}                                        check liveness via pidfile + /healthz`,
    ].join("\n"),
  );
}

async function daemonStart(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      foreground: { type: "boolean", default: false },
      "no-ui": { type: "boolean", default: false },
      open: { type: "boolean", default: false },
      // Phase 3 bind / TLS flags. Forwarded to the daemon child via
      // argv (parsed in src/daemon/index.ts).
      bind: { type: "string" },
      insecure: { type: "boolean", default: false },
      cert: { type: "string" },
      key: { type: "string" },
    },
  });

  // Per-invocation env overrides for host/port. The daemon entrypoint
  // re-reads MILL_DAEMON_HOST/PORT via loadGlobalConfig(), so propagating
  // through env is the cleanest way to thread these into the child.
  // --no-ui flips MILL_NO_UI=1 in the child env so buildServer skips
  // the static handler.
  const env = { ...process.env };
  if (values.port) env.MILL_DAEMON_PORT = values.port;
  if (values.host) env.MILL_DAEMON_HOST = values.host;
  if (values["no-ui"]) env.MILL_NO_UI = "1";

  // Forward bind / TLS flags to the daemon child via argv.
  const passthrough: string[] = [];
  if (values.bind) passthrough.push("--bind", values.bind);
  if (values.insecure) passthrough.push("--insecure");
  if (values.cert) passthrough.push("--cert", values.cert);
  if (values.key) passthrough.push("--key", values.key);

  // Fast-fail if a daemon is already up on the configured bind. The
  // daemon entrypoint also guards via the pidfile, but doing it here
  // gives a nicer message and avoids spawning a doomed child.
  const probeConfig: { daemonHost?: string; daemonPort?: string } = {};
  if (values.host) probeConfig.daemonHost = values.host;
  if (values.port) probeConfig.daemonPort = values.port;
  const probe = new DaemonClient();
  if (await probe.isLive()) {
    const h = await probe.healthz();
    console.log(
      `${dim("·")} daemon already running on ${h.host}:${h.port} ${dim(`(pid ${h.pid})`)}`,
    );
    return;
  }

  const entry = resolveDaemonEntrypoint();

  if (values.foreground) {
    // Re-exec via spawn-and-inherit so SIGINT/SIGTERM forward to the
    // child. We don't import the daemon module in-process because the
    // production binary may be `node dist/cli.js`, not tsx, and `index.ts`
    // requires the TypeScript loader.
    if (env.MILL_DAEMON_PORT) process.env.MILL_DAEMON_PORT = env.MILL_DAEMON_PORT;
    if (env.MILL_DAEMON_HOST) process.env.MILL_DAEMON_HOST = env.MILL_DAEMON_HOST;
    await new Promise<void>((res, rej) => {
      const cmd = entry.kind === "node" ? process.execPath : entry.cmd;
      const baseArgs = entry.kind === "node" ? [entry.path] : entry.args;
      const args = [...baseArgs, ...passthrough];
      const child = spawn(cmd, args, {
        stdio: "inherit",
        env,
      });
      child.on("error", rej);
      child.on("exit", (code) => {
        if (code === 0 || code === null) res();
        else rej(new Error(`daemon exited with code ${code}`));
      });
      const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
      process.on("SIGINT", forward("SIGINT"));
      process.on("SIGTERM", forward("SIGTERM"));
    });
    return;
  }

  // Detached background spawn. Ignore stdio so the child outlives this
  // CLI invocation. Poll the pidfile + /healthz so the user sees a
  // clean "running on host:port" line before we return.
  const cmd = entry.kind === "node" ? process.execPath : entry.cmd;
  const baseArgs = entry.kind === "node" ? [entry.path] : entry.args;
  const args = [...baseArgs, ...passthrough];
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();

  const pidPath = daemonPidPath();
  const ok = await pollUntil(
    async () => {
      if (!existsSync(pidPath)) return false;
      return await probe.isLive();
    },
    { timeoutMs: 10_000, intervalMs: 200 },
  );
  if (!ok) {
    console.error(
      `${red("mill:")} daemon did not become healthy within 10s. Check ~/.mill/daemon.pid and /healthz.`,
    );
    process.exitCode = 1;
    return;
  }
  const h = await probe.healthz();
  console.log(
    `${green("✓")} daemon running on ${h.host}:${h.port} ${dim(`(pid ${h.pid})`)}`,
  );
  const url = `http://${h.host}:${h.port}/`;
  if (!values["no-ui"]) {
    console.log(`${dim("·")} web UI: ${cyan(url)}`);
  }
  if (values.open && !values["no-ui"]) {
    openInBrowser(url);
  }
}

function openInBrowser(url: string): void {
  // Best-effort cross-platform "open this URL". Failures (no GUI, no
  // handler) are intentionally swallowed — the URL was already printed
  // and the user can copy it.
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // ignore
  }
}

async function daemonStop(_argv: string[]) {
  const pidPath = daemonPidPath();
  if (!existsSync(pidPath)) {
    console.log(`${dim("·")} daemon not running ${dim("(no pidfile)")}`);
    return;
  }
  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) {
    console.error(
      `${red("mill:")} daemon pidfile at ${pidPath} is not a valid pid: "${raw}"`,
    );
    process.exitCode = 1;
    return;
  }
  if (!isPidAlive(pid)) {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
    console.log(`${dim("·")} daemon not running ${dim(`(stale pid ${pid})`)}`);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${red("mill:")} kill ${pid}: ${msg}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${dim("▸")} sent SIGTERM to daemon (pid ${pid}); waiting for drain…`);
  // Daemon's drain phase can be long if a stage is mid-flight. Cap at
  // 30s — past that, surface a hint to send SIGTERM again to abort.
  const drained = await pollUntil(async () => !isPidAlive(pid), {
    timeoutMs: 30_000,
    intervalMs: 250,
  });
  if (!drained) {
    console.log(
      dim(
        `still running. Send SIGTERM again to force abort: kill ${pid}`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  console.log(`${green("✓")} daemon stopped`);
}

async function daemonStatus(_argv: string[]) {
  const pidPath = daemonPidPath();
  const portPath = daemonPortPath();
  if (!existsSync(pidPath)) {
    console.log(`${dim("·")} not running ${dim("(no pidfile)")}`);
    return;
  }
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isFinite(pid) || !isPidAlive(pid)) {
    console.log(`${dim("·")} not running ${dim(`(stale pid ${pid})`)}`);
    return;
  }
  const client = new DaemonClient();
  if (!(await client.isLive())) {
    let portHint = "";
    if (existsSync(portPath)) {
      const p = readFileSync(portPath, "utf8").trim();
      portHint = ` ${dim(`(pidfile says port ${p})`)}`;
    }
    console.log(
      `${yellow("?")} pid ${pid} alive but /healthz not responding${portHint}`,
    );
    return;
  }
  const h = await client.healthz();
  console.log(
    `${green("✓")} running on ${h.host}:${h.port} ${dim(`(pid ${h.pid}, uptime ${h.uptime_s}s)`)}`,
  );
}

// Resolve where the daemon entrypoint lives so we can spawn it. Two cases:
//  - production: `dist/cli.js` runs and `dist/daemon/index.js` is its
//    sibling — invoke with `node dist/daemon/index.js`.
//  - dev (`npm run mill -- daemon start`): we're under tsx; the CLI
//    file is `src/cli.ts`. Spawn `npx tsx src/daemon/index.ts` so the
//    child gets the same TypeScript loader.
type DaemonEntry =
  | { kind: "node"; path: string }
  | { kind: "spawn"; cmd: string; args: string[] };

function resolveDaemonEntrypoint(): DaemonEntry {
  const here = fileURLToPath(import.meta.url);
  const srcMode = here.endsWith(".ts");
  if (srcMode) {
    const tsFile = resolve(dirname(here), "daemon", "index.ts");
    return { kind: "spawn", cmd: "npx", args: ["tsx", tsFile] };
  }
  const jsFile = resolve(dirname(here), "daemon", "index.js");
  return { kind: "node", path: jsFile };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    return code === "EPERM";
  }
}

async function pollUntil(
  predicate: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(opts.intervalMs);
  }
  return false;
}

// ---------- mill auth ----------

async function cmdAuth(argv: string[]) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "init":
      return await authInit(rest);
    case "show":
      return await authShow(rest);
    case "rotate":
      return await authRotate(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      printAuthHelp();
      return;
    default:
      console.error(`mill auth: unknown subcommand "${sub}"`);
      printAuthHelp();
      process.exitCode = 2;
  }
}

function printAuthHelp() {
  console.log(
    [
      `${bold("mill auth")} — daemon authentication`,
      ``,
      `  ${cyan("mill auth init")}     generate a token at ~/.mill/auth.token (mode 0600)`,
      `  ${cyan("mill auth show")}     print the configured token`,
      `  ${cyan("mill auth rotate")}   replace the token; invalidates all UI sessions`,
      ``,
      dim(
        "After init, export MILL_AUTH_TOKEN=\"$(cat ~/.mill/auth.token)\" in your shell rc.",
      ),
      dim(
        "The CLI auto-reads the file when MILL_AUTH_TOKEN is unset, so the export is",
      ),
      dim("optional but recommended for scripts."),
    ].join("\n"),
  );
}

async function authInit(_argv: string[]) {
  const { initAuthToken, authTokenPath } = await import("./daemon/auth.js");
  const file = authTokenPath();
  if (existsSync(file)) {
    console.error(
      `${red("mill auth:")} token already exists at ${file}. ` +
        `Run \`mill auth rotate\` to replace it.`,
    );
    process.exitCode = 1;
    return;
  }
  const result = await initAuthToken();
  console.log(`${green("✓")} wrote ${bold(result.path)} ${dim("(mode 0600)")}`);
  console.log("");
  console.log(`  ${result.token}`);
  console.log("");
  console.log(
    dim(
      "Add to your shell rc:\n" +
        `  export MILL_AUTH_TOKEN="$(cat ${result.path})"`,
    ),
  );
  if (await isDaemonLive()) {
    console.log(
      dim(
        "\nDaemon is currently running — restart it to pick up the new token:\n" +
          "  mill daemon stop && mill daemon start",
      ),
    );
  }
}

async function authShow(_argv: string[]) {
  const { readAuthToken } = await import("./daemon/auth.js");
  const { path, token } = readAuthToken();
  if (!token) {
    console.error(
      `${red("mill auth:")} no token at ${path}. Run \`mill auth init\` first.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(token);
}

async function authRotate(_argv: string[]) {
  const { rotateAuthToken } = await import("./daemon/auth.js");
  const result = await rotateAuthToken();
  console.log(`${green("✓")} rotated token at ${bold(result.path)}`);
  console.log("");
  console.log(`  ${result.token}`);
  console.log("");
  // Invalidate every existing UI session so a stolen cookie can't outlive
  // the rotated token. CLI reads the central DB directly. When the daemon
  // is up it'll re-read the token on its next auth request via env/file.
  try {
    const store = openCentralStoreReadOnly();
    try {
      store.deleteAllAuthSessions();
      console.log(dim("· invalidated all UI sessions (forced re-login)"));
    } finally {
      store.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${yellow("warn:")} could not invalidate sessions: ${msg}`);
  }
  if (await isDaemonLive()) {
    console.log(
      dim(
        "\nRestart the daemon to pick up the new token:\n" +
          "  mill daemon stop && mill daemon start",
      ),
    );
  }
}

async function isDaemonLive(): Promise<boolean> {
  try {
    const client = new DaemonClient();
    return await client.isLive();
  } catch {
    return false;
  }
}

// ---------- mill new ----------

async function cmdNew(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      detach: { type: "boolean", default: false },
      "all-defaults": { type: "boolean", default: false },
      from: { type: "string" },
      mode: { type: "string", default: "auto" },
      "stop-after": { type: "string" },
      project: { type: "string" },
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

  const stopAfter = resolveStopAfter(values["stop-after"]);
  if (stopAfter === "error") {
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

  // Resolve project up front so we can do `--mode auto` detection
  // against its repo. The daemon doesn't echo back the resolved root,
  // so the CLI does this against the central DB directly — read-only.
  const store = openCentralStoreReadOnly();
  let project: ProjectRow;
  try {
    project = requireProjectForMutate(store, values.project);
  } finally {
    store.close();
  }

  const effectiveMode: RunMode =
    rawMode === "auto"
      ? await detectRunMode(project.root_path)
      : (rawMode as RunMode);

  if (rawMode === "auto") {
    console.log(`${dim("mode:")} ${effectiveMode} ${dim("(auto)")}`);
  } else {
    console.log(`${dim("mode:")} ${effectiveMode}`);
  }
  console.log(`${dim("project:")} ${bold(project.name)} ${dim(project.id)}`);

  const client = new DaemonClient();
  const body: {
    requirement: string;
    mode?: RunMode;
    stop_after?: "spec" | "design" | "spec2tests";
    all_defaults?: boolean;
  } = { requirement, mode: effectiveMode };
  if (stopAfter) body.stop_after = stopAfter;
  if (values["all-defaults"]) body.all_defaults = true;

  const created = await client.createRun(project.id, body);
  console.log(`${dim("run:")}  ${bold(created.run_id)}`);
  if (effectiveMode === "edit" && created.branch) {
    const off = created.base_branch ? ` ${dim(`(off ${created.base_branch})`)}` : "";
    console.log(`${dim("branch:")} ${created.branch}${off}`);
  }

  if (created.clarifications) {
    console.log(`${dim("kind:")} ${created.clarifications.kind}`);
    const answers = await promptForAnswers(
      created.clarifications,
      Boolean(values["all-defaults"]),
    );
    await client.submitClarifications(created.run_id, answers);
    console.log(dim("\nanswers recorded. run is now in the daemon's queue.\n"));
  } else {
    console.log(dim("\nclarifications auto-accepted. run is queued.\n"));
  }

  if (values.detach) {
    console.log(
      dim(
        "queued — daemon will pick it up. follow with `mill tail "
          + created.run_id + " -f`.",
      ),
    );
    return;
  }

  // Inline progress: poll the central DB and wait for terminal status.
  // Mutations stay in the daemon — we're just observing.
  console.log(
    `${dim("▸")} pipeline running on the daemon. Use `
      + `${cyan("mill tail " + created.run_id + " -f")} for the live stream, `
      + `or ${cyan("Ctrl-C")} to detach.`,
  );
  console.log();
  await waitForRunTerminal(created.run_id);
}

// Poll the central DB until the run reaches a terminal status; print
// the final outcome. The daemon owns the writes; we just watch.
async function waitForRunTerminal(runId: string): Promise<void> {
  const store = openCentralStoreReadOnly();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const run = store.getRun(runId);
      if (!run) {
        await sleep(500);
        continue;
      }
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "killed"
      ) {
        const proj = run.project_id ? store.getProject(run.project_id) : null;
        const paths = proj ? runPaths(proj.root_path, runId) : null;
        const stages = store.listDisplayStages(runId);
        printRunOutcome(run, stages, paths);
        return;
      }
      await sleep(1000);
    }
  } finally {
    store.close();
  }
}

function printRunOutcome(
  run: RunRow,
  stages: DisplayStageRow[],
  paths: ReturnType<typeof runPaths> | null,
) {
  const statusLabel =
    run.status === "completed"
      ? green("✓ completed")
      : run.status === "killed"
        ? red("✗ killed")
        : red("✗ failed");
  console.log();
  console.log(
    `${statusLabel}  ${dim("·")}  ${fmtCost(run.total_cost_usd)}`,
  );
  if (stages.length > 0) {
    console.log();
    const rows = stages.map((s) => [
      dim("·"),
      s.displayName,
      colorStageStatus(s.status),
      fmtCost(s.cost_usd),
      s.started_at ? dim(fmtStageDuration(s)) : dim("—"),
    ]);
    console.log(renderTable(rows, { alignRight: new Set([3]) }));
  }
  if (run.status === "completed" && paths) {
    console.log();
    console.log(`${dim("delivery:")} ${paths.delivery}`);
    console.log(`${dim("workdir:")}  ${paths.workdir}`);
  }
}

function fmtStageDuration(s: Pick<StageRow, "started_at" | "finished_at">): string {
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

// ---------- mill run ----------

async function cmdRun(argv: string[]) {
  const { positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" }, // accepted but not required (run id is unique)
    },
  });
  const runId = positionals[0];
  if (!runId) {
    console.error("mill run: run-id required");
    process.exitCode = 2;
    return;
  }
  preflightClaude();
  const client = new DaemonClient();
  await client.resumeRun(runId);
  console.log(`${dim("▸")} resumed ${bold(runId)} ${dim("on the daemon")}`);
  console.log(
    `   follow with ${cyan("mill tail " + runId + " -f")} `
      + `(${dim("Ctrl-C to detach")})`,
  );
  console.log();
  await waitForRunTerminal(runId);
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

// ---------- mill onboard ----------

async function cmdOnboard(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      refresh: { type: "boolean", default: false },
      project: { type: "string" },
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
  // Onboard is a single-shot stage; it runs in-process against the
  // resolved project. Writes profile.{md,json} into the central
  // per-project state dir, not into the repo. (Open question 7 in the
  // plan; "write to the central path immediately" is what we ship.)
  const cfgOpts = values.project
    ? { projectIdentifier: values.project }
    : {};
  const config = loadConfig(cfgOpts);
  const result = await onboard({ refresh, root: config.root });
  if (result.cached) {
    console.log(dim("profile already exists. Run `mill onboard --refresh` to rebuild."));
    return;
  }
  console.log(`${green("✓")} profile written`);
  console.log(dim(`  ${config.stateDir}/profile.md`));
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

// ---------- mill findings ----------

async function cmdFindings(argv: string[]) {
  const sub = argv[0];
  if (sub === "suppress" || sub === "unsuppress") {
    // Suppression is a write — but it's metadata, not run state. Phase
    // 1 doesn't have a daemon route for it (the plan's item-6 surface
    // doesn't list one); we open the central DB directly. Acceptable
    // because suppressions are append-only and don't race with run
    // writes.
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
    const store = openCentralStoreReadOnly();
    try {
      if (sub === "suppress") {
        store.suppressFingerprint(fp, values.note);
        console.log(`${green("✓")} suppressed ${dim(fp)}`);
      } else {
        store.unsuppressFingerprint(fp);
        console.log(`${green("✓")} unsuppressed ${dim(fp)}`);
      }
    } finally {
      store.close();
    }
    return;
  }
  if (sub === "suppressed") {
    const store = openCentralStoreReadOnly();
    try {
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
    } finally {
      store.close();
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
      project: { type: "string" },
    },
  });
  // AC-8: read-only, must work without the daemon. Open the DB
  // directly and run the same listLedgerEntries the daemon would.
  const store = openCentralStoreReadOnly();
  try {
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
  } finally {
    store.close();
  }
}

// ---------- mill history ----------

async function cmdHistory(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: { project: { type: "string" } },
  });
  const store = openCentralStoreReadOnly();
  try {
    const project = resolveProjectForRead(store, values.project);
    if (!project) {
      console.error(
        `${red("mill:")} no project resolved (cwd or --project). ` +
          `Run \`mill project ls\` to see registered projects.`,
      );
      process.exitCode = 1;
      return;
    }
    const stateDir = projectStateDir(project.id);
    const body = await readJournal(stateDir);
    if (!body.trim()) {
      console.log("(no journal yet)");
      console.log(`will be written to: ${journalPath(stateDir)}`);
      return;
    }
    process.stdout.write(body.endsWith("\n") ? body : body + "\n");
  } finally {
    store.close();
  }
}

// ---------- mill status ----------

async function cmdStatus(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      all: { type: "boolean", default: false },
    },
  });
  const store = openCentralStoreReadOnly();
  try {
    const runId = positionals[0];
    if (!runId) {
      // No run id: list mode. Honor --project (or cwd resolution) to
      // scope to one project, otherwise fall back to a cross-project
      // listing — the user with no project registered should still see
      // mill is alive.
      const project = resolveProjectForRead(store, values.project);
      if (project) {
        console.log(`${dim("project:")} ${bold(project.name)} ${dim(project.id)}`);
        console.log(dim(`  ${project.root_path}`));
        console.log();
      } else if (!values.all) {
        console.log(
          dim(
            "no project resolved from cwd. Showing all runs — use `--project <id>` to scope.",
          ),
        );
        console.log();
      }
      const listOpts: { limit: number; projectId?: string } = { limit: 20 };
      if (project) listOpts.projectId = project.id;
      const rows = store.listRuns(listOpts);
      if (rows.length === 0) {
        console.log(dim("(no runs yet — try `mill new \"...\"`)"));
        return;
      }
      const showProjectCol = !project; // cross-project view → include id
      const header = [
        dim("id"),
        ...(showProjectCol ? [dim("project")] : []),
        dim("status"),
        dim("mode"),
        dim("kind"),
        dim("cost"),
        dim("created"),
      ];
      const table = [header];
      for (const r of rows) {
        const projectCell: string[] = showProjectCol
          ? [r.project_id ?? dim("—")]
          : [];
        table.push([
          r.id,
          ...projectCell,
          colorRunStatus(r.status),
          r.mode ?? "new",
          r.kind ?? dim("—"),
          fmtCost(r.total_cost_usd),
          dim(relTime(r.created_at)),
        ]);
      }
      console.log(
        renderTable(table, {
          alignRight: new Set([showProjectCol ? 5 : 4]),
        }),
      );
      return;
    }
    const run = store.getRun(runId);
    if (!run) {
      console.error(red(`no run: ${runId}`));
      process.exitCode = 1;
      return;
    }
    const stages = store.listDisplayStages(runId);
    renderRunHeader(run, store);
    console.log();
    renderStageTable(stages, store, runId);
  } finally {
    store.close();
  }
}

function renderRunHeader(run: RunRow, store: StateStore) {
  const runTokens = totalTokens(run);
  console.log(`${bold("run")} ${bold(run.id)}`);
  const project =
    run.project_id ? store.getProject(run.project_id) : null;
  const statusCell =
    run.status === "awaiting_approval" && run.awaiting_approval_at_stage
      ? `${colorRunStatus(run.status)} ${dim(`(at ${run.awaiting_approval_at_stage})`)}`
      : run.status === "failed" && run.failure_reason
        ? `${colorRunStatus(run.status)} ${dim(`(${run.failure_reason})`)}`
        : colorRunStatus(run.status);
  const rows: string[][] = [
    [
      dim("  project"),
      project ? `${project.name} ${dim(project.id)}` : dim("—"),
    ],
    [dim("  status"), statusCell],
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
  if (run.status === "awaiting_approval") {
    console.log(
      dim(
        `\n  ${bold("→")} approve: ${cyan(`mill approve ${run.id}`)}` +
          ` or reject: ${cyan(`mill reject ${run.id} --note "..."`)}`,
      ),
    );
  } else if (run.status === "paused_budget") {
    console.log(
      dim(
        `\n  ${bold("→")} resume: ${cyan(`mill resume ${run.id}`)}` +
          ` (project must be back under monthly budget)`,
      ),
    );
  }
}

function renderStageTable(
  stages: DisplayStageRow[],
  store: StateStore | undefined,
  runId: string | undefined,
) {
  if (stages.length === 0) {
    console.log(dim("(no stages yet)"));
    return;
  }
  const highByIter = new Map<number, number>();
  if (store && runId && stages.some((s) => s.name === "review")) {
    for (const f of store.listFindings(runId)) {
      if (atLeast(f.severity, "HIGH")) {
        highByIter.set(f.iteration, (highByIter.get(f.iteration) ?? 0) + 1);
      }
    }
  }
  const notes = stages.map((s) => stageNote(s, highByIter));
  const showNote = notes.some((n) => n !== "");
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
    ...(showNote ? [dim("note")] : []),
  ];
  const rows = stages.map((s, i) => [
    s.displayName,
    colorStageStatus(s.status),
    fmtCost(s.cost_usd),
    compactTokens(s.input_tokens),
    compactTokens(s.cache_creation_tokens),
    compactTokens(s.cache_read_tokens),
    compactTokens(s.output_tokens),
    s.started_at ? dim(fmtStageDuration(s)) : dim("—"),
    s.started_at ? dim(relTime(s.started_at)) : dim("—"),
    ...(showNote ? [notes[i] ? dim(notes[i]!) : ""] : []),
  ]);
  console.log(
    renderTable([header, ...rows], {
      alignRight: new Set([2, 3, 4, 5, 6, 7]),
    }),
  );
}

function stageNote(
  s: DisplayStageRow,
  highByIter: Map<number, number>,
): string {
  if (s.name === "review" && s.iteration !== null && s.status === "completed") {
    const n = highByIter.get(s.iteration) ?? 0;
    if (n === 0) return "no HIGH+ findings";
    return `${n} HIGH+ ${n === 1 ? "finding" : "findings"}`;
  }
  return "";
}

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

// ---------- mill logs / mill tail ----------

async function cmdLogs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      follow: { type: "boolean", short: "f", default: false },
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
  const store = openCentralStoreReadOnly();
  try {
    let after = values.after ? Number(values.after) : 0;
    const limit = Number(values.limit ?? "200");

    const dump = () => {
      const events = store.tailEvents(runId, after, limit);
      for (const e of events) {
        if (raw) {
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
  } finally {
    store.close();
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
  const store = openCentralStoreReadOnly();
  try {
    const run = store.getRun(runId);
    if (!run) {
      console.error(`no run: ${runId}`);
      process.exitCode = 1;
      return;
    }
    const project = run.project_id ? store.getProject(run.project_id) : null;
    const paths = project ? runPaths(project.root_path, runId) : null;
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
        const workdir = paths?.workdir ?? "";
        const line = renderTailLine(e.kind, payload, workdir, tailOpts);
        if (line !== null) process.stdout.write(line + "\n");
        after = e.id;
      }
    };

    dump();
    if (!values.follow) return;

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
  } finally {
    store.close();
  }
}

interface TailOpts {
  verbose: boolean;
}

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

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

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
  try {
    return cap(JSON.stringify(i, null, 2));
  } catch {
    return "";
  }
}

// ---------- mill kill ----------

async function cmdKill(argv: string[]) {
  const runId = argv[0];
  if (!runId) {
    console.error("mill kill: run-id required");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  const out = await client.killRun(runId);
  console.log(`${red("✗")} kill sentinel written for ${bold(runId)}`);
  console.log(dim(`  ${out.killed_path}`));
  console.log(dim("  run stops on the next tool call inside the claude subprocess."));
}

// ---------- mill approve / reject / resume ----------

async function cmdApprove(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      note: { type: "string" },
    },
  });
  const runId = positionals[0];
  if (!runId) {
    console.error("mill approve: run-id required");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  const out = await client.approveRun(runId, values.note);
  console.log(
    `${green("✓")} approved ${bold(runId)} → status ${colorRunStatus(out.status)}`,
  );
  if (values.note) console.log(dim(`  note: ${values.note}`));
}

async function cmdReject(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      note: { type: "string" },
    },
  });
  const runId = positionals[0];
  if (!runId) {
    console.error("mill reject: run-id required");
    process.exitCode = 2;
    return;
  }
  if (!values.note) {
    console.error("mill reject: --note \"<reason>\" is required");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  const out = await client.rejectRun(runId, values.note);
  console.log(
    `${red("✗")} rejected ${bold(runId)} → status ${colorRunStatus(out.status)}`,
  );
  console.log(dim(`  note: ${values.note}`));
}

async function cmdResume(argv: string[]) {
  const runId = argv[0];
  if (!runId) {
    console.error("mill resume: run-id required");
    process.exitCode = 2;
    return;
  }
  const client = new DaemonClient();
  const out = await client.resumeRun(runId);
  console.log(
    `${green("→")} resumed ${bold(runId)} → status ${colorRunStatus(out.status)}`,
  );
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
