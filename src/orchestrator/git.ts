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
