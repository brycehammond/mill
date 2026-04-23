import { resolve } from "node:path";

export interface DfConfig {
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

export function loadConfig(): DfConfig {
  const root = process.env.DF_ROOT
    ? resolve(process.env.DF_ROOT)
    : resolve(process.cwd());
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
