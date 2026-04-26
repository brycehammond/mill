import { mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RunPaths } from "./types.js";
import { MILL_DIR, RUNS_DIRNAME } from "./project.js";

// ---- central state (~/.mill) ----
//
// Phase 1 of multi-project mill: management state (the SQLite DB,
// per-project journals, decisions log, profile, stitch ref) lives at
// `~/.mill/`, NOT inside each repo's `.mill/`. Per-run workdirs and
// run-scoped artifacts (KILLED sentinel, verify/, reviews/, design/)
// stay at `<repo>/.mill/runs/<id>/...` so CLAUDE.md auto-discovery and
// the `git worktree add` flow keep working unchanged.
//
// Override the central root with `MILL_HOME=/path/to/dir` for
// scripts/tests/CI; defaults to `$HOME/.mill`.

export const PROJECTS_DIRNAME = "projects";
export const DAEMON_PIDFILE = "daemon.pid";
export const DAEMON_PORTFILE = "daemon.port";
export const CENTRAL_DB_FILENAME = "mill.db";

export function millRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MILL_HOME;
  if (override && override.trim()) return resolve(override.trim());
  return join(homedir(), ".mill");
}

export function centralDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(millRoot(env), CENTRAL_DB_FILENAME);
}

export function projectStateDir(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(millRoot(env), PROJECTS_DIRNAME, projectId);
}

export function projectJournalPath(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(projectStateDir(projectId, env), "journal.md");
}

export function projectDecisionsPath(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(projectStateDir(projectId, env), "decisions.md");
}

export function projectProfileJsonPath(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(projectStateDir(projectId, env), "profile.json");
}

export function projectProfileMdPath(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(projectStateDir(projectId, env), "profile.md");
}

export function projectStitchPath(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(projectStateDir(projectId, env), "stitch.json");
}

export function daemonPidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(millRoot(env), DAEMON_PIDFILE);
}

export function daemonPortPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(millRoot(env), DAEMON_PORTFILE);
}

export async function ensureMillRoot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = millRoot(env);
  await mkdir(root, { recursive: true });
  await mkdir(join(root, PROJECTS_DIRNAME), { recursive: true });
  return root;
}

export async function ensureProjectStateDir(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dir = projectStateDir(projectId, env);
  await mkdir(dir, { recursive: true });
  return dir;
}

// `root` here is the project root (the directory containing `.mill/`).
// Run artifacts live under `.mill/runs/<runId>/` so the whole state tree
// is scoped to the project and gitignored as a single entry.
export function runPaths(root: string, runId: string): RunPaths {
  const absRoot = resolve(root);
  const runDir = join(absRoot, MILL_DIR, RUNS_DIRNAME, runId);
  const designDir = join(runDir, "design");
  return {
    root: absRoot,
    runDir,
    requirement: join(runDir, "requirement.md"),
    clarifications: join(runDir, "clarifications.json"),
    spec: join(runDir, "spec.md"),
    designDir,
    designIntent: join(designDir, "design_intent.md"),
    architecture: join(designDir, "architecture.md"),
    stitchUrl: join(designDir, "stitch_url.txt"),
    designScreens: join(designDir, "screens"),
    workdir: join(runDir, "workdir"),
    reviewsDir: join(runDir, "reviews"),
    verifyDir: join(runDir, "verify"),
    delivery: join(runDir, "delivery.md"),
    killed: join(runDir, "KILLED"),
    events: join(runDir, "events.ndjson"),
  };
}

export interface EnsureRunDirsOpts {
  // In edit mode the workdir is materialized by `git worktree add`,
  // which refuses to create into an existing directory. Callers pass
  // `createWorkdir: false` to skip that mkdir; every other dir is
  // still created unconditionally.
  createWorkdir?: boolean;
}

export async function ensureRunDirs(
  paths: RunPaths,
  opts: EnsureRunDirsOpts = {},
): Promise<void> {
  const createWorkdir = opts.createWorkdir ?? true;
  await mkdir(paths.runDir, { recursive: true });
  await mkdir(paths.designDir, { recursive: true });
  await mkdir(paths.designScreens, { recursive: true });
  if (createWorkdir) {
    await mkdir(paths.workdir, { recursive: true });
  }
  await mkdir(paths.reviewsDir, { recursive: true });
  await mkdir(paths.verifyDir, { recursive: true });
}

// Short sortable id: yyyymmdd-hhmmss + 4 random base36 chars.
// Chosen over UUIDv4 because `ls runs/` is already human-meaningful.
export function newRunId(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rnd}`;
}

export function isInsideDir(child: string, parent: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (c === p) return true;
  return c.startsWith(p + "/");
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function killedSentinelExists(killedPath: string): boolean {
  return existsSync(killedPath);
}
