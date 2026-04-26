import { writeFile } from "node:fs/promises";
import {
  ensureRunDirs,
  inspectRepoState,
  newRunId,
  runPaths,
  slugifyRequirement,
} from "../../core/index.js";
import type { RunMode, StateStore } from "../../core/index.js";
import {
  configureGitIdentity,
  gitTag,
  gitWorktreeAdd,
  gitHead,
} from "../git.js";

export interface IntakeArgs {
  requirement: string;
  root: string;
  store: StateStore;
  mode: RunMode;
  // Owning project — required so the run row is correctly attributed
  // in the central registry. Caller (CLI / daemon) is responsible for
  // resolving the project before calling intake.
  projectId: string;
}

export interface IntakeResult {
  runId: string;
  requirementPath: string;
  mode: RunMode;
  branch: string | null;
  baseBranch: string | null;
}

// Intake is synchronous and runs from the CLI process. It records the
// requirement on disk, creates the run row in the store, and returns the
// fresh id so the CLI can continue with clarify inline. In edit mode it
// also materializes a git worktree on a fresh `mill/run-<id>` branch — the
// implement stage then writes commits into that worktree.
export async function intake(args: IntakeArgs): Promise<IntakeResult> {
  const runId = newRunId();
  const paths = runPaths(args.root, runId);
  const mode = args.mode;

  if (mode === "edit") {
    // Preflight before creating the run row so a blocked repo state
    // doesn't leave a dangling run behind.
    const state = await inspectRepoState(args.root);
    if (!state.hasCommits) {
      throw new Error(
        "mill: edit mode requires the repo to have at least one commit. " +
          "Make an initial commit, or pass --mode new.",
      );
    }
    if (state.inProgressOp) {
      throw new Error(
        `mill: repository is mid-${state.inProgressOp}; complete or abort it first, then retry.`,
      );
    }
  }

  // `git worktree add` requires the target path to not exist. Skip the
  // workdir mkdir in edit mode; gitWorktreeAdd creates it.
  await ensureRunDirs(paths, { createWorkdir: mode !== "edit" });
  await writeFile(paths.requirement, args.requirement.trim() + "\n", "utf8");

  args.store.createRun({
    id: runId,
    project_id: args.projectId,
    status: "queued",
    kind: null,
    mode,
    created_at: Date.now(),
    requirement_path: paths.requirement,
    spec_path: null,
  });
  args.store.appendEvent(runId, "intake", "created", {
    requirement_path: paths.requirement,
    mode,
  });

  let branch: string | null = null;
  let baseBranch: string | null = null;
  if (mode === "edit") {
    const state = await inspectRepoState(args.root);
    baseBranch = state.currentBranch;
    // Branch name: `mill/<slug-from-requirement>-<shortId>`. Suffix is
    // the run id's last 4 chars (random base36) so two runs with the
    // same intent don't collide. Falls back to the legacy `run-<runId>`
    // form when the requirement degenerates to all stop words.
    const slug = slugifyRequirement(args.requirement);
    const shortId = runId.slice(-4);
    branch = slug ? `mill/${slug}-${shortId}` : `mill/run-${runId}`;
    try {
      await gitWorktreeAdd(args.root, branch, paths.workdir, "HEAD");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      args.store.appendEvent(runId, "intake", "worktree_failed", {
        branch,
        error: msg,
      });
      args.store.updateRun(runId, { status: "failed" });
      args.store.finishStage(runId, "intake", {
        status: "failed",
        error: `git worktree add failed: ${msg}`,
      });
      throw new Error(`git worktree add failed: ${msg}`);
    }
    await configureGitIdentity(paths.workdir);
    // Anchor impl/iter-0 at the base HEAD so the adversarial critic
    // always has a stable diff reference in edit mode, mirroring the
    // empty-initial-commit tag that new-mode runs make in implement.
    await gitTag(paths.workdir, "impl/iter-0");
    const baseSha = await gitHead(paths.workdir);
    args.store.appendEvent(runId, "intake", "worktree_created", {
      branch,
      baseBranch,
      baseSha,
    });
  }

  args.store.finishStage(runId, "intake", {
    status: "completed",
    artifact_path: paths.requirement,
  });

  return {
    runId,
    requirementPath: paths.requirement,
    mode,
    branch,
    baseBranch,
  };
}
