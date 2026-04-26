import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  readStitchRef,
  stitchRefPath,
  writeStitchRef,
  type StitchProjectRef,
} from "./stitch.js";

async function tempProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mill-stitch-"));
  // mill.db / state lives under .mill/; create it so writeStitchRef
  // can write into it (writeFile won't mkdir for us).
  await mkdir(join(root, ".mill"), { recursive: true });
  return root;
}

describe("stitch project ref", () => {
  it("round-trips a ref through write + read", async () => {
    const root = await tempProjectRoot();
    const ref: StitchProjectRef = {
      projectUrl: "https://stitch.app/p/abc123",
      lastRunId: "20260425-204318-xyzz",
      updatedAt: "2026-04-25T20:30:00.000Z",
    };
    await writeStitchRef(root, ref);
    const got = await readStitchRef(root);
    assert.deepEqual(got, ref);
  });

  it("returns null when the file is missing", async () => {
    const root = await tempProjectRoot();
    assert.equal(await readStitchRef(root), null);
  });

  it("returns null when the file has unparseable JSON", async () => {
    const root = await tempProjectRoot();
    await writeFile(stitchRefPath(root), "not json{", "utf8");
    assert.equal(await readStitchRef(root), null);
  });

  it("returns null when JSON is missing required fields", async () => {
    const root = await tempProjectRoot();
    await writeFile(
      stitchRefPath(root),
      JSON.stringify({ projectUrl: "" }),
      "utf8",
    );
    assert.equal(await readStitchRef(root), null);
  });

  it("overwrites on second write (most-recent wins)", async () => {
    const root = await tempProjectRoot();
    await writeStitchRef(root, {
      projectUrl: "https://stitch.app/p/old",
      lastRunId: "run-1",
      updatedAt: "2026-04-25T19:00:00.000Z",
    });
    await writeStitchRef(root, {
      projectUrl: "https://stitch.app/p/new",
      lastRunId: "run-2",
      updatedAt: "2026-04-25T20:00:00.000Z",
    });
    const got = await readStitchRef(root);
    assert.equal(got?.projectUrl, "https://stitch.app/p/new");
    assert.equal(got?.lastRunId, "run-2");
  });
});
