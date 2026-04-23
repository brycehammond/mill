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
  await git(cwd, ["config", "user.email", "df@dark-factory.local"]);
  await git(cwd, ["config", "user.name", "dark-factory"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
  // Never commit the harness's per-run .claude/ sandbox config — it's
  // injected at run time, not part of the delivered artifact.
  await appendFile(
    join(cwd, ".git", "info", "exclude"),
    "\n# dark-factory harness sandbox — do not commit\n.claude/\n",
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
