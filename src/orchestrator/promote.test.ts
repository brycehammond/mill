import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  isParentSafeForAutoPromote,
  promoteWorkdir,
  resolvePromoteMode,
} from "./promote.js";

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
