import { writeFile } from "node:fs/promises";
import { ensureRunDirs, newRunId, runPaths } from "../../core/index.js";
import type { StateStore } from "../../core/index.js";

export interface IntakeArgs {
  requirement: string;
  root: string;
  store: StateStore;
}

export interface IntakeResult {
  runId: string;
  requirementPath: string;
}

// Intake is synchronous and runs from the CLI process. It records the
// requirement on disk, creates the run row in the store, and returns the
// fresh id so the CLI can continue with clarify inline.
export async function intake(args: IntakeArgs): Promise<IntakeResult> {
  const runId = newRunId();
  const paths = runPaths(args.root, runId);
  await ensureRunDirs(paths);
  await writeFile(paths.requirement, args.requirement.trim() + "\n", "utf8");

  args.store.createRun({
    id: runId,
    status: "queued",
    kind: null,
    created_at: Date.now(),
    requirement_path: paths.requirement,
    spec_path: null,
  });
  args.store.appendEvent(runId, "intake", "created", {
    requirement_path: paths.requirement,
  });
  args.store.finishStage(runId, "intake", {
    status: "completed",
    artifact_path: paths.requirement,
  });

  return { runId, requirementPath: paths.requirement };
}
