// Per-project "profile" produced by `mill onboard`. A one-time
// discovery pass that records the codebase's stack, command set, and
// conventions so that every run that follows can inject that summary
// into stage prompts instead of re-discovering it turn by turn.
//
// Two files live next to each other in `.mill/`:
// - `profile.md`  — human-readable + prompt-injectable
// - `profile.json`— structured fields the pipeline accesses
//                   programmatically (e.g. `commands.test` for the
//                   tests critic).

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ProfileCommands {
  test: string | null;
  build: string | null;
  lint: string | null;
  typecheck: string | null;
  devServer: string | null;
  format: string | null;
}

export interface ProfileData {
  // ISO timestamp the profile was last refreshed.
  generatedAt: string;
  // One-line identifier of the stack ("Node/TypeScript CLI", etc).
  stack: string;
  // Programmatic commands — run with a shell, no shell injection
  // concerns because they're human-edited and the pipeline is trusted.
  commands: ProfileCommands;
  // Glob patterns the pipeline must not write to.
  doNotTouch: string[];
  // Human-readable markdown summary that goes into prompts. Kept
  // separate from the structured fields so the model can write prose
  // without every word being load-bearing.
  markdown: string;
}

const JSON_FILENAME = "profile.json";
const MD_FILENAME = "profile.md";

export function profileJsonPath(stateDir: string): string {
  return join(stateDir, JSON_FILENAME);
}

export function profileMdPath(stateDir: string): string {
  return join(stateDir, MD_FILENAME);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function profileExists(stateDir: string): Promise<boolean> {
  return fileExists(profileJsonPath(stateDir));
}

export async function readProfile(stateDir: string): Promise<ProfileData | null> {
  const p = profileJsonPath(stateDir);
  if (!(await fileExists(p))) return null;
  try {
    const raw = await readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProfileData>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      generatedAt: String(parsed.generatedAt ?? ""),
      stack: String(parsed.stack ?? ""),
      commands: {
        test: (parsed.commands?.test ?? null) || null,
        build: (parsed.commands?.build ?? null) || null,
        lint: (parsed.commands?.lint ?? null) || null,
        typecheck: (parsed.commands?.typecheck ?? null) || null,
        devServer: (parsed.commands?.devServer ?? null) || null,
        format: (parsed.commands?.format ?? null) || null,
      },
      doNotTouch: Array.isArray(parsed.doNotTouch) ? parsed.doNotTouch : [],
      markdown: String(parsed.markdown ?? ""),
    };
  } catch {
    return null;
  }
}

// Read just the prompt-injectable summary. Empty string if no profile.
// Prefer `profile.md` on disk (user may have hand-edited it) and fall
// back to the embedded markdown from the JSON.
export async function readProfileSummary(stateDir: string): Promise<string> {
  const mdPath = profileMdPath(stateDir);
  if (await fileExists(mdPath)) {
    try {
      const body = await readFile(mdPath, "utf8");
      if (body.trim()) return body.trim();
    } catch {
      // fall through
    }
  }
  const data = await readProfile(stateDir);
  return data?.markdown?.trim() ?? "";
}

// Resolve the test command that should run for a given run. Prefer the
// run-scoped command (set by spec2tests in any mode) over the project
// profile; fall back to null if neither is set.
//
// The run-scoped field lets new-mode builds — which don't have a project
// profile — still gate review on real test output.
export async function resolveTestCommand(args: {
  stateDir: string;
  runTestCommand: string | null | undefined;
}): Promise<string | null> {
  const run = typeof args.runTestCommand === "string" ? args.runTestCommand.trim() : "";
  if (run) return run;
  const profile = await readProfile(args.stateDir);
  return profile?.commands.test || null;
}

export async function writeProfile(
  stateDir: string,
  data: ProfileData,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    profileJsonPath(stateDir),
    JSON.stringify(data, null, 2) + "\n",
    "utf8",
  );
  await writeFile(profileMdPath(stateDir), data.markdown.trim() + "\n", "utf8");
}
