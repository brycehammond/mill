// Per-project Stitch project reference. Edit-mode design runs read
// this to reuse an existing Stitch project (via `edit_screens`) instead
// of always calling `create_project`. Lives at `.mill/stitch.json`,
// next to `journal.md` / `decisions.md` / `profile.json`.
//
// Most-recent-successful-design wins: the design.ui stage overwrites
// the file whenever it gets a non-empty `stitch_url` back from the
// model. Stale-URL recovery is the model's job (the design-ui-edit
// prompt instructs `get_project` first; on not-found, fall back to
// `create_project` and the new URL is written here on success).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StitchProjectRef {
  projectUrl: string;
  lastRunId: string;
  updatedAt: string;
}

export function stitchRefPath(stateDir: string): string {
  return join(stateDir, "stitch.json");
}

// Defensive read: missing file or unparseable JSON returns null so
// callers can cleanly fall back to "no prior project."
export async function readStitchRef(
  stateDir: string,
): Promise<StitchProjectRef | null> {
  const path = stitchRefPath(stateDir);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isStitchRef(parsed)) return null;
  return parsed;
}

export async function writeStitchRef(
  stateDir: string,
  ref: StitchProjectRef,
): Promise<void> {
  const path = stitchRefPath(stateDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ref, null, 2) + "\n", "utf8");
}

function isStitchRef(v: unknown): v is StitchProjectRef {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.projectUrl === "string" &&
    r.projectUrl.length > 0 &&
    typeof r.lastRunId === "string" &&
    typeof r.updatedAt === "string"
  );
}
