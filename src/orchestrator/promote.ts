// Promote the per-run workdir up into the project root.
//
// New-mode runs build into `.mill/runs/<id>/workdir/` so the harness can
// sandbox writes and so multiple runs can coexist. But the workdir is
// not where users naturally look for the result — they look at the
// project root. After a clean delivery, copy the workdir contents up
// into the root so the deliverable is "right there."
//
// Edit-mode runs are unaffected; they already commit on a branch in the
// user's worktree and (optionally) open a PR.
//
// Constraints:
//  - Never clobber the parent's `.git/` (workdir has its own;
//    overwriting would destroy whatever git history existed at root).
//  - Never copy `.mill/` into itself (the workdir doesn't have one
//    today, but defensive).
//  - Preserve a `/.mill/` ignore rule when the workdir's `.gitignore`
//    overwrites the parent's. The default `mill init` writes that rule
//    so the per-run state stays out of commits.
//  - A failure must not fail the run. Caller logs and continues.

import { cp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PromoteArgs {
  workdir: string;
  root: string;
}

export interface PromoteResult {
  promoted: boolean;
  // When promoted=false, why not. When true, what we did.
  reason: string;
  filesCopied?: number;
}

export type PromoteMode = "auto" | "on" | "off";

export function resolvePromoteMode(env = process.env): PromoteMode {
  const raw = (env.MILL_PROMOTE_NEW_WORKDIR ?? "auto").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return "on";
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  return "auto";
}

// Entries the parent root is *expected* to have — not user content.
// `auto` mode treats anything else as "the user has files here, don't
// silently overwrite."
const PARENT_EXPECTED_ENTRIES = new Set([".git", ".gitignore", ".mill"]);

// Entries we never copy from the workdir to the root.
const WORKDIR_SKIP = new Set([".git", ".mill"]);

export async function isParentSafeForAutoPromote(root: string): Promise<boolean> {
  const entries = await readdir(root);
  for (const name of entries) {
    if (!PARENT_EXPECTED_ENTRIES.has(name)) return false;
  }
  return true;
}

export async function promoteWorkdir(
  args: PromoteArgs & { mode: PromoteMode },
): Promise<PromoteResult> {
  const { workdir, root, mode } = args;
  if (mode === "off") {
    return { promoted: false, reason: "MILL_PROMOTE_NEW_WORKDIR=off" };
  }
  if (mode === "auto" && !(await isParentSafeForAutoPromote(root))) {
    return {
      promoted: false,
      reason:
        "parent root has user content beyond {.git,.gitignore,.mill}; set MILL_PROMOTE_NEW_WORKDIR=on to override",
    };
  }

  const entries = await readdir(workdir);
  let filesCopied = 0;
  for (const name of entries) {
    if (WORKDIR_SKIP.has(name)) continue;
    const src = join(workdir, name);
    const dst = join(root, name);
    if (name === ".gitignore") {
      await mergeGitignore(src, dst);
      filesCopied += 1;
      continue;
    }
    await cp(src, dst, { recursive: true, force: true });
    filesCopied += await countFiles(src);
  }
  return {
    promoted: true,
    reason: "ok",
    filesCopied,
  };
}

// Workdir's .gitignore tends to be language-specific (e.g. Swift's
// `.build/`, `.swiftpm/`). The parent root's gitignore — if it exists —
// usually contains the `/.mill/` rule that `mill init` lays down. A
// straight copy would lose that. Merge: take the workdir's content as
// the base, then re-add any `/.mill/`-shaped rule that was in the
// parent. If the parent's .gitignore had other custom rules, those are
// preserved too via append-with-dedup.
async function mergeGitignore(src: string, dst: string): Promise<void> {
  const incoming = await readFile(src, "utf8");
  let existing = "";
  try {
    existing = await readFile(dst, "utf8");
  } catch {
    // No existing .gitignore at root — just write incoming.
    await writeFile(dst, incoming, "utf8");
    return;
  }
  const incomingLines = new Set(
    incoming.split("\n").map((l) => l.trim()).filter(Boolean),
  );
  const additions: string[] = [];
  for (const raw of existing.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (incomingLines.has(line)) continue;
    additions.push(line);
  }
  const merged = additions.length
    ? `${incoming.trimEnd()}\n${additions.join("\n")}\n`
    : incoming;
  await writeFile(dst, merged, "utf8");
}

async function countFiles(path: string): Promise<number> {
  const s = await stat(path);
  if (s.isFile()) return 1;
  if (!s.isDirectory()) return 0;
  let n = 0;
  for (const entry of await readdir(path)) {
    n += await countFiles(join(path, entry));
  }
  return n;
}
