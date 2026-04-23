// Project discovery and init.
//
// A "project" is a git repo with a `.df/` sibling to `.git/`. All
// dark-factory state — the SQLite DB and per-run artifacts — lives under
// `.df/` so it travels with the repo checkout and is trivially isolated
// from everything else in the tree. There is no global index; every
// command resolves the current project by walking up from cwd.

import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { RunMode } from "./types.js";

const execFileP = promisify(execFile);

export interface ProjectInfo {
  name: string;
  path: string;
  created_at: number;
}

export const DF_DIR = ".df";
export const DB_FILENAME = "dark-factory.db";
export const RUNS_DIRNAME = "runs";
export const PROJECT_FILENAME = "project.json";

// ---------- per-project paths ----------

export function projectDfDir(projectRoot: string): string {
  return join(resolve(projectRoot), DF_DIR);
}

export function projectDbPath(projectRoot: string): string {
  return join(projectDfDir(projectRoot), DB_FILENAME);
}

export function projectRunsDir(projectRoot: string): string {
  return join(projectDfDir(projectRoot), RUNS_DIRNAME);
}

export function projectInfoPath(projectRoot: string): string {
  return join(projectDfDir(projectRoot), PROJECT_FILENAME);
}

// ---------- discovery ----------

// Walk up from `from` looking for a directory that contains `.df/project.json`.
// The canonical project marker is `project.json` (written by `df init`);
// the DB file comes into existence lazily on the first store write.
export function findProjectRoot(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  const root = resolve(dir, sep);
  while (true) {
    if (existsSync(join(dir, DF_DIR, PROJECT_FILENAME))) return dir;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readProjectInfo(projectRoot: string): ProjectInfo | null {
  const p = projectInfoPath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (raw && typeof raw.name === "string") {
      return {
        name: raw.name,
        path: resolve(projectRoot),
        created_at: Number(raw.created_at) || 0,
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}

// ---------- init ----------

export interface InitProjectArgs {
  cwd?: string;
  name?: string;
}

export interface InitProjectResult {
  projectRoot: string;
  info: ProjectInfo;
  created: boolean; // false = already initialized, we just re-registered
  gitignoreUpdated: boolean;
}

// Creates `.df/` at the git repo root. Requires being inside a git repo
// — "scoped to the repository" is the whole point. If `.df/` already
// exists we leave its contents alone and just refresh the registry.
export function initProject(args: InitProjectArgs = {}): InitProjectResult {
  const cwd = resolve(args.cwd ?? process.cwd());
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    throw new Error(
      "df init must run inside a git repository (no .git found walking up from cwd)",
    );
  }

  const dfDir = projectDfDir(gitRoot);
  const alreadyExists = existsSync(dfDir);
  mkdirSync(dfDir, { recursive: true });
  mkdirSync(projectRunsDir(gitRoot), { recursive: true });

  const now = Date.now();
  const existingInfo = readProjectInfo(gitRoot);
  const name = args.name ?? existingInfo?.name ?? basename(gitRoot);
  const info: ProjectInfo = {
    name,
    path: gitRoot,
    created_at: existingInfo?.created_at ?? now,
  };
  writeFileSync(
    projectInfoPath(gitRoot),
    JSON.stringify(info, null, 2) + "\n",
    "utf8",
  );

  const gitignoreUpdated = ensureGitignoreEntry(gitRoot, "/.df/");

  return {
    projectRoot: gitRoot,
    info,
    created: !alreadyExists,
    gitignoreUpdated,
  };
}

// ---------- helpers ----------

function findGitRoot(from: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: from,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const root = out.trim();
    if (root && existsSync(root)) return resolve(root);
  } catch {
    // not a git repo, or git not on PATH
  }
  return null;
}

// Returns true if we wrote to .gitignore, false if the entry was already
// present (or .gitignore doesn't exist and we skipped).
function ensureGitignoreEntry(repoRoot: string, entry: string): boolean {
  const path = join(repoRoot, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, `${entry}\n`, "utf8");
    return true;
  }
  const body = readFileSync(path, "utf8");
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(entry.replace(/^\//, ""))) {
    return false;
  }
  const needsNewline = body.length > 0 && !body.endsWith("\n");
  appendFileSync(path, `${needsNewline ? "\n" : ""}${entry}\n`, "utf8");
  return true;
}

// Exposed for tests / status output.
export function projectDbExists(projectRoot: string): boolean {
  try {
    return statSync(projectDbPath(projectRoot)).isFile();
  } catch {
    return false;
  }
}

// ---------- repo state + run-mode detection ----------

export interface RepoState {
  hasCommits: boolean;
  trackedSourceCount: number;
  currentBranch: string | null; // "detached@<sha>" if detached
  inProgressOp: "merge" | "rebase" | "cherry-pick" | null;
}

// Files that count as "repo metadata", not user source. Tracked files
// outside this allowlist push auto-detection toward edit mode.
const META_FILES = new Set([
  ".gitignore",
  ".gitattributes",
  "README.md",
  "README",
  "README.rst",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  ".env.example",
]);

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function inspectRepoState(root: string): Promise<RepoState> {
  let hasCommits = false;
  try {
    await gitOut(root, ["rev-parse", "--verify", "HEAD"]);
    hasCommits = true;
  } catch {
    hasCommits = false;
  }

  let trackedSourceCount = 0;
  try {
    const out = await gitOut(root, ["ls-files"]);
    const files = out.split("\n").map((l) => l.trim()).filter(Boolean);
    trackedSourceCount = files.filter(
      (f) => !META_FILES.has(f) && !f.startsWith(".df/"),
    ).length;
  } catch {
    trackedSourceCount = 0;
  }

  let currentBranch: string | null = null;
  if (hasCommits) {
    try {
      const out = (
        await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"])
      ).trim();
      if (out === "HEAD") {
        const sha = (await gitOut(root, ["rev-parse", "--short", "HEAD"])).trim();
        currentBranch = `detached@${sha}`;
      } else if (out) {
        currentBranch = out;
      }
    } catch {
      currentBranch = null;
    }
  }

  let inProgressOp: RepoState["inProgressOp"] = null;
  const gitDir = join(root, ".git");
  if (existsSync(join(gitDir, "MERGE_HEAD"))) inProgressOp = "merge";
  else if (
    existsSync(join(gitDir, "rebase-apply")) ||
    existsSync(join(gitDir, "rebase-merge"))
  )
    inProgressOp = "rebase";
  else if (existsSync(join(gitDir, "CHERRY_PICK_HEAD")))
    inProgressOp = "cherry-pick";

  return { hasCommits, trackedSourceCount, currentBranch, inProgressOp };
}

// Heuristic: no commits OR no non-meta tracked files → scaffold into an
// isolated workdir under `.df/runs/<id>/workdir/`. Otherwise the repo
// already has code the user will want df to edit — route through edit
// mode with a git worktree.
export async function detectRunMode(root: string): Promise<RunMode> {
  const state = await inspectRepoState(root);
  if (!state.hasCommits) return "new";
  if (state.trackedSourceCount === 0) return "new";
  return "edit";
}
