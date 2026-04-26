import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  centralDbPath,
  millRoot,
  openStore,
  projectStateDir,
  resolveProjectByIdentifier,
  resolveProjectFromCwd,
  type ProjectRow,
  type StageName,
  type StateStore,
} from "../core/index.js";

export interface GlobalMillConfig {
  // Central state root (`~/.mill/`, override via `MILL_HOME`).
  millHome: string;
  // Central SQLite database (`<millHome>/mill.db`).
  dbPath: string;
  // Daemon localhost bind. The CLI client also reads these to talk to
  // a running daemon. Loopback only — no remote access in Phase 1.
  daemonHost: string;
  daemonPort: number;
  // Run-execution caps shared across all projects served by the daemon.
  maxConcurrentRuns: number;
  maxReviewIters: number;
  timeoutSecPerRun: number;
  timeoutSecPerStage: number;
  timeoutSecPerStageOverrides: Partial<Record<StageName, number>>;
  model: string | undefined;
}

// Project-scoped config: global pieces plus the currently-selected
// project's root/stateDir/projectId. Returned by `loadConfig()` for
// CLI commands that operate on a single project.
export interface MillConfig extends GlobalMillConfig {
  project: ProjectRow;
  projectId: string;
  // Project repo root (= project.root_path). Where workdirs live and
  // git operates. Distinct from `stateDir`.
  root: string;
  // Central per-project state directory (`<millHome>/projects/<id>/`).
  stateDir: string;
}

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function strEnv(name: string, fallback: string): string {
  const v = process.env[name];
  if (typeof v === "string" && v.trim()) return v.trim();
  return fallback;
}

export class NoProjectError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "no mill project resolved from cwd. Run `mill project add` to register this repo, or pass `--project <id|name|path>`.",
    );
  }
}

// Global pieces only — no project lookup. Used by the daemon
// entrypoint and by reads that span all projects (`mill project ls`,
// `mill findings` cross-project mode).
export function loadGlobalConfig(): GlobalMillConfig {
  const millHomePath = millRoot();
  // Eagerly create the central root so the SQLite open below succeeds.
  mkdirSync(millHomePath, { recursive: true });
  return {
    millHome: millHomePath,
    dbPath: centralDbPath(),
    daemonHost: strEnv("MILL_DAEMON_HOST", "127.0.0.1"),
    daemonPort: numEnv("MILL_DAEMON_PORT", 7333),
    maxConcurrentRuns: numEnv("MILL_MAX_CONCURRENT_RUNS", 2),
    maxReviewIters: numEnv("MILL_MAX_REVIEW_ITERS", 3),
    timeoutSecPerRun: numEnv("MILL_TIMEOUT_SEC_PER_RUN", 14400),
    timeoutSecPerStage: numEnv("MILL_TIMEOUT_SEC_PER_STAGE", 600),
    timeoutSecPerStageOverrides: {
      implement: numEnv("MILL_TIMEOUT_SEC_IMPLEMENT", 7200),
      verify: numEnv("MILL_TIMEOUT_SEC_VERIFY", 1800),
    },
    model: process.env.MILL_MODEL || undefined,
  };
}

export interface LoadConfigOpts {
  cwd?: string;
  // `--project <id|name|path>` from the CLI. When set, takes precedence
  // over cwd-walk resolution.
  projectIdentifier?: string;
  // For tests / scripts that already opened the store. When omitted,
  // `loadConfig` opens its own (and closes it before returning is the
  // caller's responsibility to manage if they need to keep it open).
  store?: StateStore;
}

export function loadConfig(opts: LoadConfigOpts = {}): MillConfig {
  const global = loadGlobalConfig();
  mkdirSync(dirname(global.dbPath), { recursive: true });
  const store = opts.store ?? openStore(global.dbPath);
  const project = resolveProject(store, opts);
  if (!project) throw new NoProjectError();
  return {
    ...global,
    project,
    projectId: project.id,
    root: project.root_path,
    stateDir: projectStateDir(project.id),
  };
}

function resolveProject(
  store: StateStore,
  opts: LoadConfigOpts,
): ProjectRow | null {
  const ident = opts.projectIdentifier?.trim();
  if (ident) {
    const byIdent = resolveProjectByIdentifier(store, ident);
    if (byIdent && byIdent.removed_at === null) return byIdent;
    return null;
  }
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
  return resolveProjectFromCwd(store, cwd);
}

// Pick the `--setting-sources` list passed to in-run `claude` subprocesses.
// Default `["user", "project"]` so the user's installed skills, hooks, and
// status-line/output-style customizations fire inside the run — same as a
// normal Claude Code session. `MILL_USER_HOOKS=off` reverts to project-only
// isolation (e.g. for shared/CI environments where user-level Stop or
// PostToolUse hooks would be inappropriate).
export function defaultSettingSources(
  env: NodeJS.ProcessEnv = process.env,
): Array<"user" | "project" | "local"> {
  const raw = (env.MILL_USER_HOOKS ?? "on").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return ["project"];
  return ["user", "project"];
}
