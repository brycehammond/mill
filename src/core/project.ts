// Project discovery and registration.
//
// Phase 1 of multi-project mill: a "project" is a git repo registered
// against the central registry at `~/.mill/`. Projects are first-class
// entities — rows in `~/.mill/mill.db::projects` — keyed by an absolute
// `root_path`. The legacy per-repo `<root>/.mill/` directory still exists
// for run workdirs only; management state (DB, journal, decisions,
// profile, stitch) lives centrally per project at
// `~/.mill/projects/<project-id>/`.
//
// `mill init` is deprecated in favor of `mill project add`.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { MigrateLegacyResult } from "./migrate.js";
import { migrateLegacyMill } from "./migrate.js";
import type { ProjectRow, RunMode, StateStore } from "./types.js";

const execFileP = promisify(execFile);

export interface ProjectInfo {
  name: string;
  path: string;
  created_at: number;
}

export const MILL_DIR = ".mill";
export const DB_FILENAME = "mill.db";
export const RUNS_DIRNAME = "runs";
export const PROJECT_FILENAME = "project.json";

// ---------- per-project paths ----------

export function projectMillDir(projectRoot: string): string {
  return join(resolve(projectRoot), MILL_DIR);
}

export function projectDbPath(projectRoot: string): string {
  return join(projectMillDir(projectRoot), DB_FILENAME);
}

export function projectRunsDir(projectRoot: string): string {
  return join(projectMillDir(projectRoot), RUNS_DIRNAME);
}

export function projectInfoPath(projectRoot: string): string {
  return join(projectMillDir(projectRoot), PROJECT_FILENAME);
}

// ---------- discovery ----------

// Walk up from `from` looking for a directory that contains `.mill/project.json`.
// The canonical project marker is `project.json` (written by `mill init`);
// the DB file comes into existence lazily on the first store write.
export function findProjectRoot(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  const root = resolve(dir, sep);
  while (true) {
    if (existsSync(join(dir, MILL_DIR, PROJECT_FILENAME))) return dir;
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

// Creates `.mill/` at the git repo root. Requires being inside a git repo
// — "scoped to the repository" is the whole point. If `.mill/` already
// exists we leave its contents alone and just refresh the registry.
export function initProject(args: InitProjectArgs = {}): InitProjectResult {
  const cwd = resolve(args.cwd ?? process.cwd());
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    throw new Error(
      "mill init must run inside a git repository (no .git found walking up from cwd)",
    );
  }

  const millDir = projectMillDir(gitRoot);
  const alreadyExists = existsSync(millDir);
  mkdirSync(millDir, { recursive: true });
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

  const gitignoreUpdated = ensureGitignoreEntry(gitRoot, "/.mill/");

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
      (f) => !META_FILES.has(f) && !f.startsWith(".mill/"),
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
// isolated workdir under `.mill/runs/<id>/workdir/`. Otherwise the repo
// already has code the user will want mill to edit — route through edit
// mode with a git worktree.
export async function detectRunMode(root: string): Promise<RunMode> {
  const state = await inspectRepoState(root);
  if (!state.hasCommits) return "new";
  if (state.trackedSourceCount === 0) return "new";
  return "edit";
}

// ---------- multi-project registration ----------

export interface AddProjectArgs {
  rootPath: string;
  name?: string;
  monthlyBudgetUsd?: number | null;
  defaultConcurrency?: number | null;
}

export interface AddProjectResult {
  project: ProjectRow;
  // false when this rootPath was already registered — addProject is
  // idempotent: same path → same row, no-op insert.
  created: boolean;
  // Populated only when this call inserted a new project row AND the
  // repo had a legacy `<repoRoot>/.mill/mill.db` to import. A second
  // `addProject` against the same path returns `created: false` and
  // skips migration entirely, so this stays undefined for re-adds.
  migration?: MigrateLegacyResult;
}

// Generate a stable, human-readable project id: slugified basename plus
// a 4-char fingerprint of the absolute path. The fingerprint guards
// against name collisions ("dotfiles" + "dotfiles") without making ids
// cryptic. Deterministic on the path alone, so rerunning gives the
// same id and the central DB stays referentially stable.
export function deriveProjectId(rootPath: string): string {
  const abs = resolve(rootPath);
  const slug = slugifyName(basename(abs)) || "project";
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 4);
  return `${slug}-${hash}`;
}

function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Register a git repo as a project. Validates that `rootPath` resolves
// to a git repo (the daemon and pipeline assume `git` works there for
// worktrees, intake, etc.). Idempotent: returns the existing row when
// the path is already registered.
//
// On the first registration of a repo that has a legacy
// `<repoRoot>/.mill/mill.db` (single-project mill predates the central
// registry), this also runs `migrateLegacyMill` to import runs/stages/
// events/findings/etc. into the central DB and copy state files
// (journal/decisions/profile/stitch) into the project's central state
// dir. Re-adds (when the project is already registered) skip migration
// — the migration marker file at `.mill/migrated-to-central.json` also
// guarantees idempotence even if the caller calls migration manually.
export async function addProject(
  store: StateStore,
  args: AddProjectArgs,
): Promise<AddProjectResult> {
  const abs = resolve(args.rootPath);
  if (!existsSync(abs)) {
    throw new Error(`addProject: path does not exist: ${abs}`);
  }
  const gitRoot = findGitRoot(abs);
  if (!gitRoot) {
    throw new Error(
      `addProject: not a git repository (no .git found from ${abs}). Run \`git init\` first.`,
    );
  }
  // Always register the git toplevel — passing a subdirectory of a repo
  // resolves up to the repo itself so we don't end up with one project
  // per directory.
  const canonical = gitRoot;
  const existing = store.getProjectByPath(canonical);
  if (existing) {
    return { project: existing, created: false };
  }
  const id = ensureUniqueProjectId(store, canonical, args.name);
  const name = args.name?.trim() || basename(canonical);
  const project = store.addProject({
    id,
    name,
    root_path: canonical,
    monthly_budget_usd: args.monthlyBudgetUsd ?? null,
    default_concurrency: args.defaultConcurrency ?? null,
  });
  const migration = await migrateLegacyMill({
    repoRoot: canonical,
    projectId: project.id,
    store,
  });
  return { project, created: true, migration };
}

// Generate the deterministic id; if a different project already holds
// that id (effectively impossible with sha1 truncation but worth
// guarding), append a numeric suffix until free.
function ensureUniqueProjectId(
  store: StateStore,
  rootPath: string,
  _name: string | undefined,
): string {
  const base = deriveProjectId(rootPath);
  if (!store.getProject(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!store.getProject(candidate)) return candidate;
  }
  throw new Error(`addProject: could not derive unique id for ${rootPath}`);
}

// Walk up from cwd; if any ancestor matches a registered project's
// root_path, return that project. Returns null when cwd is outside all
// registered projects.
//
// Both the start dir and each ancestor are canonicalized via realpath
// so a cwd like `/tmp/...` matches a registered `/private/tmp/...`
// (macOS symlinks `/tmp` to `/private/tmp`; `git rev-parse` always
// returns the canonical form).
export function resolveProjectFromCwd(
  store: StateStore,
  cwd: string = process.cwd(),
): ProjectRow | null {
  let dir = canonicalize(resolve(cwd));
  const fsRoot = resolve(dir, sep);
  while (true) {
    const hit = store.getProjectByPath(dir);
    if (hit && hit.removed_at === null) return hit;
    if (dir === fsRoot) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolve a `--project <id|name|path>` flag value. Order: exact id,
// exact path (after resolve+realpath), then name. Returns null on no match.
export function resolveProjectByIdentifier(
  store: StateStore,
  identifier: string,
): ProjectRow | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const byId = store.getProject(trimmed);
  if (byId) return byId;
  const asPath = canonicalize(resolve(trimmed));
  if (existsSync(asPath)) {
    const byPath = store.getProjectByPath(asPath);
    if (byPath) return byPath;
  }
  return store.getProjectByName(trimmed);
}

function canonicalize(p: string): string {
  try {
    // realpathSync resolves symlinks (e.g. macOS /tmp → /private/tmp).
    // Falls back to the literal path on errors so a missing dir
    // doesn't crash resolution.
    return realpathSync(p);
  } catch {
    return p;
  }
}
