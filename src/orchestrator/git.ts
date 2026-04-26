import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export async function gitInit(cwd: string): Promise<void> {
  await git(cwd, ["init", "--initial-branch=main"]).catch(async () => {
    await git(cwd, ["init"]);
    await git(cwd, ["checkout", "-b", "main"]).catch(() => {});
  });
  await configureGitIdentity(cwd);
}

// Shared between gitInit (new-mode workdir) and the edit-mode worktree
// bootstrap in intake. Safe to run repeatedly — `git config` is local
// to the (work)tree and appendFile on info/exclude is idempotent
// modulo duplicate lines, which git tolerates.
export async function configureGitIdentity(cwd: string): Promise<void> {
  await git(cwd, ["config", "user.email", "mill@mill.local"]);
  await git(cwd, ["config", "user.name", "mill"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
  // Never commit the harness's per-run .claude/ sandbox config — it's
  // injected at run time, not part of the delivered artifact.
  // For a worktree, `rev-parse --git-path info/exclude` returns the
  // worktree-local exclude file; falls back to .git/info/exclude for a
  // plain repo.
  const excludeRel = (
    await git(cwd, ["rev-parse", "--git-path", "info/exclude"])
  ).trim();
  const excludeAbs = excludeRel.startsWith("/") ? excludeRel : join(cwd, excludeRel);
  await appendFile(
    excludeAbs,
    "\n# mill harness sandbox — do not commit\n.claude/\n.mill/\n",
    "utf8",
  );
}

export async function gitCommitAll(cwd: string, message: string): Promise<string | null> {
  await git(cwd, ["add", "-A"]);
  const status = await git(cwd, ["status", "--porcelain"]);
  if (!status.trim()) return null;
  await git(cwd, ["commit", "-m", message, "--allow-empty-message"]);
  const sha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  return sha;
}

// Force a commit (empty or not) so we have a base SHA to diff against.
// Used once at run start to anchor the impl/iter-0 tag.
export async function gitCommitEmpty(cwd: string, message: string): Promise<string> {
  await git(cwd, ["commit", "--allow-empty", "-m", message]);
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

export async function gitTag(cwd: string, tag: string): Promise<void> {
  await git(cwd, ["tag", tag, "-f"]);
}

export async function gitHead(cwd: string): Promise<string | null> {
  try {
    const sha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    return sha || null;
  } catch {
    return null;
  }
}

export async function gitCheckoutBranch(cwd: string, branch: string): Promise<void> {
  // Create branch at HEAD if it doesn't exist, else switch.
  try {
    await git(cwd, ["checkout", branch]);
  } catch {
    await git(cwd, ["checkout", "-b", branch]);
  }
}

// Create a fresh branch from <startPoint> and check it out into <path>
// as a linked worktree. <path> must not exist yet — git enforces this.
export async function gitWorktreeAdd(
  root: string,
  branch: string,
  path: string,
  startPoint: string = "HEAD",
): Promise<void> {
  await git(root, ["worktree", "add", "-b", branch, path, startPoint]);
}

export async function gitDiffStat(cwd: string, range: string): Promise<string> {
  try {
    return (await git(cwd, ["diff", "--stat", range])).trimEnd();
  } catch {
    return "";
  }
}

// Read the current branch name (HEAD's symbolic ref). Returns null on
// detached HEAD or on a fresh repo with no commits — both of which mean
// "no branch to import" for our purposes.
export async function gitCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const name = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (!name || name === "HEAD") return null;
    return name;
  } catch {
    return null;
  }
}

// Fetch <branch> from <fromPath> (a local path to another git repo or
// linked worktree) into <cwd> as `refs/heads/<branch>`. Force-update so a
// re-run that resumes a stage can overwrite a stale ref.
//
// `--update-head-ok` is required when the destination branch is also the
// current worktree's HEAD (common for `mill new` against a fresh dir
// where both the workdir and the just-init'd parent default to `main`).
// Without this flag git refuses with "refusing to fetch into branch
// '...' checked out at '...'".
export async function gitFetchBranch(
  cwd: string,
  fromPath: string,
  branch: string,
): Promise<void> {
  await git(cwd, [
    "fetch",
    "--update-head-ok",
    fromPath,
    `+${branch}:refs/heads/${branch}`,
  ]);
}

// True iff refs/heads/<branch> exists in the repo at cwd.
export async function gitBranchExists(
  cwd: string,
  branch: string,
): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// True when the repo at cwd has any commits on HEAD. New-init parent
// repos report false here; we use that to decide whether to checkout the
// imported branch into the working tree.
export async function gitHasHead(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export async function gitIsRepo(cwd: string): Promise<boolean> {
  try {
    const out = (
      await git(cwd, ["rev-parse", "--is-inside-work-tree"])
    ).trim();
    return out === "true";
  } catch {
    return false;
  }
}
