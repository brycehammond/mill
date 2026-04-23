import {
  BudgetTrackerImpl,
  createLogger,
  ensureRunDirs,
  openStore,
  runPaths,
  type RunContext,
  type StateStore,
} from "../core/index.js";
import type { DfConfig } from "./config.js";
import { writeRunSettings } from "./run-settings.js";

export interface BuildContextArgs {
  runId: string;
  config: DfConfig;
  store?: StateStore;
}

export async function buildContext(args: BuildContextArgs): Promise<RunContext> {
  const { runId, config } = args;
  const store = args.store ?? openStore(config.root);
  const paths = runPaths(config.root, runId);
  const existingRun = store.getRun(runId);
  const mode = existingRun?.mode ?? "new";
  // In edit mode the workdir is owned by `git worktree add` (done at
  // intake). A stray `mkdir` would win the race only on pre-intake
  // context builds — never actually happens today — but skipping keeps
  // the invariant clean.
  await ensureRunDirs(paths, { createWorkdir: mode !== "edit" });
  // Drop the per-run sandbox settings.json so Claude Code's cwd-walk picks it
  // up. Safe to rewrite on resume — the config is deterministic.
  writeRunSettings({ paths });
  const budget = new BudgetTrackerImpl(
    config.budgetUsdPerRun,
    config.budgetUsdPerStage,
    existingRun?.total_cost_usd ?? 0,
  );
  const logger = createLogger({ runId });
  const abortController = new AbortController();
  const ctx: RunContext = {
    runId,
    kind: existingRun?.kind ?? null,
    mode,
    paths,
    store,
    abortController,
    budget,
    logger,
    model: config.model,
    root: config.root,
    stageTimeoutMs: config.timeoutSecPerStage * 1000,
  };
  return ctx;
}
