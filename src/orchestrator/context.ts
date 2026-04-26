import {
  CostTrackerImpl,
  createLogger,
  ensureRunDirs,
  ensureProjectStateDir,
  openStore,
  projectStateDir,
  runPaths,
  type RunContext,
  type StageName,
  type StateStore,
} from "../core/index.js";
import type { GlobalMillConfig } from "./config.js";
import { writeRunSettings } from "./run-settings.js";

export interface BuildContextArgs {
  runId: string;
  // Only the global pieces are needed; project-specific paths are
  // resolved from the run row's `project_id` so the daemon can build a
  // context for any project's run without a per-project pre-loaded
  // config.
  config: GlobalMillConfig;
  store?: StateStore;
}

export async function buildContext(args: BuildContextArgs): Promise<RunContext> {
  const { runId, config } = args;
  const store = args.store ?? openStore(config.dbPath);
  const existingRun = store.getRun(runId);
  if (!existingRun) {
    throw new Error(`buildContext: run not found: ${runId}`);
  }
  if (!existingRun.project_id) {
    throw new Error(
      `buildContext: run ${runId} is missing project_id (legacy row?). ` +
        `Run \`mill project add\` to register and migrate the owning repo.`,
    );
  }
  const project = store.getProject(existingRun.project_id);
  if (!project) {
    throw new Error(
      `buildContext: project ${existingRun.project_id} not found for run ${runId}`,
    );
  }
  const root = project.root_path;
  const stateDir = projectStateDir(project.id);
  await ensureProjectStateDir(project.id);

  const paths = runPaths(root, runId);
  const mode = existingRun.mode ?? "new";
  // In edit mode the workdir is owned by `git worktree add` (done at
  // intake). A stray `mkdir` would win the race only on pre-intake
  // context builds — never actually happens today — but skipping keeps
  // the invariant clean.
  await ensureRunDirs(paths, { createWorkdir: mode !== "edit" });
  // Drop the per-run sandbox settings.json so Claude Code's cwd-walk picks it
  // up. Safe to rewrite on resume — the config is deterministic.
  writeRunSettings({ paths });
  const costs = new CostTrackerImpl(existingRun.total_cost_usd ?? 0);
  const logger = createLogger({ runId });
  const abortController = new AbortController();
  const stageTimeoutsMs: Partial<Record<StageName, number>> = {};
  for (const [stage, sec] of Object.entries(config.timeoutSecPerStageOverrides)) {
    if (typeof sec === "number" && sec > 0) {
      stageTimeoutsMs[stage as StageName] = sec * 1000;
    }
  }
  const ctx: RunContext = {
    runId,
    projectId: project.id,
    kind: existingRun.kind ?? null,
    mode,
    paths,
    store,
    abortController,
    costs,
    logger,
    model: config.model,
    root,
    stateDir,
    stageTimeoutMs: config.timeoutSecPerStage * 1000,
    stageTimeoutsMs,
  };
  return ctx;
}
