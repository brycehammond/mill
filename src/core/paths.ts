import { mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunPaths } from "./types.js";
import { DF_DIR, RUNS_DIRNAME } from "./project.js";

// `root` here is the project root (the directory containing `.df/`).
// Run artifacts live under `.df/runs/<runId>/` so the whole state tree
// is scoped to the project and gitignored as a single entry.
export function runPaths(root: string, runId: string): RunPaths {
  const absRoot = resolve(root);
  const runDir = join(absRoot, DF_DIR, RUNS_DIRNAME, runId);
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
