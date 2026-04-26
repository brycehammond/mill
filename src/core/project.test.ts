import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  addProject,
  deriveProjectId,
  resolveProjectByIdentifier,
  resolveProjectFromCwd,
} from "./project.js";
import { SqliteStateStore } from "./store.sqlite.js";

function freshStore(): SqliteStateStore {
  const s = new SqliteStateStore(":memory:");
  s.init();
  return s;
}

async function tempGitRepo(): Promise<string> {
  // Canonicalize: macOS /tmp -> /private/tmp, and `git rev-parse
  // --show-toplevel` always returns the canonical form. Tests compare
  // path equality, so resolve the symlink up front.
  const dir = await mkdtemp(join(tmpdir(), "mill-proj-"));
  const root = realpathSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

describe("project registration", () => {
  it("deriveProjectId is deterministic and slugifies the basename", () => {
    const a = deriveProjectId("/tmp/foo/My App");
    const b = deriveProjectId("/tmp/foo/My App");
    assert.equal(a, b);
    assert.match(a, /^my-app-[0-9a-f]{4}$/);
  });

  it("addProject is idempotent on the same root_path", async () => {
    const root = await tempGitRepo();
    const s = freshStore();
    const first = await addProject(s, { rootPath: root });
    const second = await addProject(s, { rootPath: root });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.project.id, second.project.id);
    s.close();
  });

  it("addProject rejects a non-git directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mill-nogit-"));
    const s = freshStore();
    await assert.rejects(addProject(s, { rootPath: dir }), /git repository/);
    s.close();
  });

  it("resolveProjectFromCwd walks up from a subdirectory", async () => {
    const root = await tempGitRepo();
    const s = freshStore();
    await addProject(s, { rootPath: root });
    const sub = join(root, "src", "deep");
    execFileSync("mkdir", ["-p", sub]);
    const found = resolveProjectFromCwd(s, sub);
    assert.ok(found);
    assert.equal(found.root_path, root);
    s.close();
  });

  it("resolveProjectFromCwd returns null when cwd is outside any project", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "mill-stray-"));
    const s = freshStore();
    assert.equal(resolveProjectFromCwd(s, elsewhere), null);
    s.close();
  });

  it("resolveProjectByIdentifier matches by id, name, or path", async () => {
    const root = await tempGitRepo();
    const s = freshStore();
    const { project } = await addProject(s, { rootPath: root, name: "alpha" });
    assert.equal(resolveProjectByIdentifier(s, project.id)?.id, project.id);
    assert.equal(resolveProjectByIdentifier(s, "alpha")?.id, project.id);
    assert.equal(resolveProjectByIdentifier(s, root)?.id, project.id);
    assert.equal(resolveProjectByIdentifier(s, "no-such"), null);
    s.close();
  });
});
