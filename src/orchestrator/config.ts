import { resolve } from "node:path";
import { findProjectRoot } from "../core/index.js";

export interface DfConfig {
  // Project root: the directory containing `.mill/`. Every command that
  // touches state is scoped to this root. `mill init` creates it;
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
      "no mill project found in this tree — run `mill init` to create one",
    );
  }
}

// Find the project the caller is cd'd inside, or honor MILL_ROOT for
// scripts/tests that run outside a project tree. Throws NoProjectError
// when no project is resolvable so the CLI can print a friendly message.
export function loadConfig(): DfConfig {
  const root = resolveProjectRoot();
  if (!root) throw new NoProjectError();
  return {
    root,
    budgetUsdPerRun: numEnv("MILL_BUDGET_USD_PER_RUN", 20),
    budgetUsdPerStage: numEnv("MILL_BUDGET_USD_PER_STAGE", 5),
    timeoutSecPerRun: numEnv("MILL_TIMEOUT_SEC_PER_RUN", 3600),
    timeoutSecPerStage: numEnv("MILL_TIMEOUT_SEC_PER_STAGE", 600),
    maxConcurrentRuns: numEnv("MILL_MAX_CONCURRENT_RUNS", 2),
    maxReviewIters: numEnv("MILL_MAX_REVIEW_ITERS", 3),
    model: process.env.MILL_MODEL || undefined,
  };
}

// MILL_ROOT overrides discovery for scripts/tests; otherwise walk up from
// cwd. `mill init` command can call this before a project exists and
// handle the null itself.
export function resolveProjectRoot(): string | null {
  if (process.env.MILL_ROOT) return resolve(process.env.MILL_ROOT);
  return findProjectRoot(process.cwd());
}
