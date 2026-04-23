import { resolve } from "node:path";
import { findProjectRoot } from "../core/index.js";

export interface DfConfig {
  // Project root: the directory containing `.df/`. Every command that
  // touches state is scoped to this root. `df init` creates it;
  // `loadConfig()` refuses to return without one.
  root: string;
  budgetUsdPerRun: number;
  budgetUsdPerStage: number;
  timeoutSecPerRun: number;
  timeoutSecPerStage: number;
  maxConcurrentRuns: number;
  maxReviewIters: number;
  model: string | undefined;
}

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export class NoProjectError extends Error {
  constructor() {
    super(
      "no dark-factory project found in this tree — run `df init` to create one",
    );
  }
}

// Find the project the caller is cd'd inside, or honor DF_ROOT for
// scripts/tests that run outside a project tree. Throws NoProjectError
// when no project is resolvable so the CLI can print a friendly message.
export function loadConfig(): DfConfig {
  const root = resolveProjectRoot();
  if (!root) throw new NoProjectError();
  return {
    root,
    budgetUsdPerRun: numEnv("DF_BUDGET_USD_PER_RUN", 20),
    budgetUsdPerStage: numEnv("DF_BUDGET_USD_PER_STAGE", 5),
    timeoutSecPerRun: numEnv("DF_TIMEOUT_SEC_PER_RUN", 3600),
    timeoutSecPerStage: numEnv("DF_TIMEOUT_SEC_PER_STAGE", 600),
    maxConcurrentRuns: numEnv("DF_MAX_CONCURRENT_RUNS", 2),
    maxReviewIters: numEnv("DF_MAX_REVIEW_ITERS", 3),
    model: process.env.DF_MODEL || undefined,
  };
}

// DF_ROOT overrides discovery for scripts/tests; otherwise walk up from
// cwd. `df init` command can call this before a project exists and
// handle the null itself.
export function resolveProjectRoot(): string | null {
  if (process.env.DF_ROOT) return resolve(process.env.DF_ROOT);
  return findProjectRoot(process.cwd());
}
