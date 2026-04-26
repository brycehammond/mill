import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  importWorkdirBranchToParent,
  isParentSafeForAutoPromote,
  promoteWorkdir,
  resolvePromoteMode,
} from "./promote.js";

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout;
}

async function initRepoWithCommit(
  dir: string,
  branch: string,
  filename: string,
  content: string,
): Promise<void> {
  await git(dir, ["init", "--initial-branch=" + branch]).catch(async () => {
    await git(dir, ["init"]);
    await git(dir, ["checkout", "-b", branch]);
  });
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, filename), content, "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "initial"]);
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `mill-promote-${prefix}-`));
}

describe("resolvePromoteMode", () => {
  it("defaults to auto when env var is absent", () => {
    assert.equal(resolvePromoteMode({}), "auto");
  });
  it("normalizes truthy/falsy aliases", () => {
    assert.equal(resolvePromoteMode({ MILL_PROMOTE_NEW_WORKDIR: "ON" }), "on");
    assert.equal(resolvePromoteMode({ MILL_PROMOTE_NEW_WORKDIR: "true" }), "on");
    assert.equal(resolvePromoteMode({ MILL_PROMOTE_NEW_WORKDIR: "1" }), "on");
    assert.equal(resolvePromoteMode({ MILL_PROMOTE_NEW_WORKDIR: "off" }), "off");
    assert.equal(resolvePromoteMode({ MILL_PROMOTE_NEW_WORKDIR: "0" }), "off");
    assert.equal(
      resolvePromoteMode({ MILL_PROMOTE_NEW_WORKDIR: "garbage" }),
      "auto",
    );
  });
});

describe("isParentSafeForAutoPromote", () => {
  it("returns true when root has only expected entries", async () => {
    const root = await tempDir("safe");
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".mill"));
    await writeFile(join(root, ".gitignore"), "/.mill/\n", "utf8");
    assert.equal(await isParentSafeForAutoPromote(root), true);
  });

  it("returns false when root has user content", async () => {
    const root = await tempDir("dirty");
    await writeFile(join(root, "README.md"), "# hi\n", "utf8");
    assert.equal(await isParentSafeForAutoPromote(root), false);
  });

  it("returns true when root is empty", async () => {
    const root = await tempDir("empty");
    assert.equal(await isParentSafeForAutoPromote(root), true);
  });
});

describe("promoteWorkdir", () => {
  async function buildScenario(): Promise<{ workdir: string; root: string }> {
    const workdir = await tempDir("wd");
    const root = await tempDir("root");
    // Workdir contents — typical Swift package shape.
    await mkdir(join(workdir, "App"));
    await writeFile(
      join(workdir, "App", "Main.swift"),
      "// app\n",
      "utf8",
    );
    await writeFile(
      join(workdir, "Package.swift"),
      "// pkg\n",
      "utf8",
    );
    await writeFile(
      join(workdir, ".gitignore"),
      ".build/\n.swiftpm/\n",
      "utf8",
    );
    // Workdir's own .git — must be skipped during the copy or it will
    // clobber the parent's git history.
    await mkdir(join(workdir, ".git"));
    await writeFile(join(workdir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    return { workdir, root };
  }

  it("copies workdir contents into root, excluding .git", async () => {
    const { workdir, root } = await buildScenario();
    const result = await promoteWorkdir({ workdir, root, mode: "on" });
    assert.equal(result.promoted, true);
    const entries = await readdir(root);
    assert.deepEqual(entries.sort(), [".gitignore", "App", "Package.swift"]);
    // Confirm the parent's .git wasn't created from the workdir's .git.
    const dotGit = entries.find((e) => e === ".git");
    assert.equal(dotGit, undefined);
  });

  it("merges .gitignore so /.mill/ rule survives", async () => {
    const { workdir, root } = await buildScenario();
    // Parent already has the `mill init`-style rule.
    await writeFile(join(root, ".gitignore"), "/.mill/\n", "utf8");
    await promoteWorkdir({ workdir, root, mode: "on" });
    const merged = await readFile(join(root, ".gitignore"), "utf8");
    assert.match(merged, /\.build\//);
    assert.match(merged, /\.swiftpm\//);
    assert.match(merged, /\/\.mill\//);
  });

  it("auto mode skips when parent has user content", async () => {
    const { workdir, root } = await buildScenario();
    await writeFile(join(root, "README.md"), "# user\n", "utf8");
    const result = await promoteWorkdir({ workdir, root, mode: "auto" });
    assert.equal(result.promoted, false);
    assert.match(result.reason, /user content/);
    // Parent should be unchanged — no Package.swift copied.
    const entries = await readdir(root);
    assert.ok(!entries.includes("Package.swift"));
  });

  it("off mode never promotes", async () => {
    const { workdir, root } = await buildScenario();
    const result = await promoteWorkdir({ workdir, root, mode: "off" });
    assert.equal(result.promoted, false);
    assert.match(result.reason, /off/);
  });

  it("on mode promotes even when parent has user content", async () => {
    const { workdir, root } = await buildScenario();
    await writeFile(join(root, "README.md"), "# user\n", "utf8");
    const result = await promoteWorkdir({ workdir, root, mode: "on" });
    assert.equal(result.promoted, true);
    const entries = await readdir(root);
    assert.ok(entries.includes("Package.swift"));
    assert.ok(entries.includes("README.md")); // user file preserved (not in workdir)
  });
});

describe("importWorkdirBranchToParent", () => {
  it("imports new-mode branch into a fresh parent (no .git yet)", async () => {
    const workdir = await tempDir("import-wd");
    const root = await tempDir("import-root");
    await initRepoWithCommit(workdir, "main", "hello.txt", "hi\n");

    const result = await importWorkdirBranchToParent({ workdir, root });
    assert.equal(result.imported, true, `outcome=${result.outcome}`);
    assert.equal(result.branch, "main");
    assert.equal(result.outcome, "checkout");

    // Parent should now have main branch with the import file checked out.
    const branches = await git(root, ["branch", "--list"]);
    assert.match(branches, /main/);
    const log = await git(root, ["log", "--oneline"]);
    assert.match(log, /initial/);
    const file = await readFile(join(root, "hello.txt"), "utf8");
    assert.equal(file, "hi\n");
  });

  it("imports branch into a parent that already has its own commits", async () => {
    const workdir = await tempDir("import-wd2");
    const root = await tempDir("import-root2");
    await initRepoWithCommit(root, "main", "parent.txt", "parent\n");
    await initRepoWithCommit(workdir, "feature", "child.txt", "child\n");

    const result = await importWorkdirBranchToParent({ workdir, root });
    assert.equal(result.imported, true);
    assert.equal(result.branch, "feature");
    assert.equal(result.outcome, "ref-only");

    // Parent's HEAD should still be on `main` with parent.txt; the
    // imported branch lives in refs but isn't checked out.
    const head = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    assert.equal(head, "main");
    const branches = await git(root, ["branch", "--list"]);
    assert.match(branches, /feature/);
    const featureLog = await git(root, ["log", "--oneline", "feature"]);
    assert.match(featureLog, /initial/);
  });

  it("is a no-op for an edit-mode worktree (branch already in parent)", async () => {
    const root = await tempDir("import-edit-root");
    const worktree = await tempDir("import-edit-wt");
    // Set up the parent and create a linked worktree on a fresh branch.
    await initRepoWithCommit(root, "main", "main.txt", "main\n");
    // git worktree add requires the target path to not exist; remove it first.
    const { rm } = await import("node:fs/promises");
    await rm(worktree, { recursive: true, force: true });
    await git(root, ["worktree", "add", "-b", "mill/test-branch", worktree, "HEAD"]);
    await writeFile(join(worktree, "feature.txt"), "feature\n", "utf8");
    await git(worktree, ["config", "user.email", "test@example.com"]);
    await git(worktree, ["config", "user.name", "test"]);
    await git(worktree, ["add", "-A"]);
    await git(worktree, ["commit", "-m", "add feature"]);

    const result = await importWorkdirBranchToParent({
      workdir: worktree,
      root,
      branch: "mill/test-branch",
    });
    assert.equal(result.imported, true, `outcome=${result.outcome}`);
    assert.equal(result.branch, "mill/test-branch");
    assert.equal(result.outcome, "ref-only");

    // Branch is reachable from the parent and points at the worktree's commit.
    const branchLog = await git(root, ["log", "--oneline", "mill/test-branch"]);
    assert.match(branchLog, /add feature/);
  });

  it("returns skip-no-branch when workdir has no resolvable branch", async () => {
    const workdir = await tempDir("no-branch-wd");
    const root = await tempDir("no-branch-root");
    // workdir not a git repo at all — gitCurrentBranch returns null.
    const result = await importWorkdirBranchToParent({ workdir, root });
    assert.equal(result.imported, false);
    assert.equal(result.outcome, "skip-no-branch");
  });
});
