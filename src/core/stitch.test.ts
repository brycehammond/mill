import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  readStitchRef,
  stitchRefPath,
  writeStitchRef,
  type StitchProjectRef,
} from "./stitch.js";

async function tempStateDir(): Promise<string> {
  // Standalone temp dir — the per-project state dir is now passed
  // directly (no `<root>/.mill/` join). writeStitchRef mkdir's parents,
  // so the dir doesn't need pre-existing children.
  return mkdtemp(join(tmpdir(), "mill-stitch-"));
}

describe("stitch project ref", () => {
  it("round-trips a ref through write + read", async () => {
    const dir = await tempStateDir();
    const ref: StitchProjectRef = {
      projectUrl: "https://stitch.app/p/abc123",
      lastRunId: "20260425-204318-xyzz",
      updatedAt: "2026-04-25T20:30:00.000Z",
    };
    await writeStitchRef(dir, ref);
    const got = await readStitchRef(dir);
    assert.deepEqual(got, ref);
  });

  it("returns null when the file is missing", async () => {
    const dir = await tempStateDir();
    assert.equal(await readStitchRef(dir), null);
  });

  it("returns null when the file has unparseable JSON", async () => {
    const dir = await tempStateDir();
    await writeFile(stitchRefPath(dir), "not json{", "utf8");
    assert.equal(await readStitchRef(dir), null);
  });

  it("returns null when JSON is missing required fields", async () => {
    const dir = await tempStateDir();
    await writeFile(
      stitchRefPath(dir),
      JSON.stringify({ projectUrl: "" }),
      "utf8",
    );
    assert.equal(await readStitchRef(dir), null);
  });

  it("overwrites on second write (most-recent wins)", async () => {
    const dir = await tempStateDir();
    await writeStitchRef(dir, {
      projectUrl: "https://stitch.app/p/old",
      lastRunId: "run-1",
      updatedAt: "2026-04-25T19:00:00.000Z",
    });
    await writeStitchRef(dir, {
      projectUrl: "https://stitch.app/p/new",
      lastRunId: "run-2",
      updatedAt: "2026-04-25T20:00:00.000Z",
    });
    const got = await readStitchRef(dir);
    assert.equal(got?.projectUrl, "https://stitch.app/p/new");
    assert.equal(got?.lastRunId, "run-2");
  });
});
