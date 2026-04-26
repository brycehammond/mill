import { resolve } from "node:path";
import { findProjectRoot, type StageName } from "../core/index.js";

export interface MillConfig {
  // Project root: the directory containing `.mill/`. Every command that
  // touches state is scoped to this root. `mill init` creates it;
  // `loadConfig()` refuses to return without one.
  root: string;
  timeoutSecPerRun: number;
  timeoutSecPerStage: number;
  // Per-stage overrides. Stages not listed inherit timeoutSecPerStage.
  // implement/verify default to 1800s because they genuinely write a lot
  // of code; everyone else is fine at 600s.
  timeoutSecPerStageOverrides: Partial<Record<StageName, number>>;
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
export function loadConfig(): MillConfig {
  const root = resolveProjectRoot();
  if (!root) throw new NoProjectError();
  return {
    root,
    timeoutSecPerRun: numEnv("MILL_TIMEOUT_SEC_PER_RUN", 14400),
    timeoutSecPerStage: numEnv("MILL_TIMEOUT_SEC_PER_STAGE", 600),
    timeoutSecPerStageOverrides: {
      implement: numEnv("MILL_TIMEOUT_SEC_IMPLEMENT", 7200),
      verify: numEnv("MILL_TIMEOUT_SEC_VERIFY", 1800),
    },
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

// Pick the `--setting-sources` list passed to in-run `claude` subprocesses.
// Default `["user", "project"]` so the user's installed skills, hooks, and
// status-line/output-style customizations fire inside the run — same as a
// normal Claude Code session. `MILL_USER_HOOKS=off` reverts to project-only
// isolation (e.g. for shared/CI environments where user-level Stop or
// PostToolUse hooks would be inappropriate).
export function defaultSettingSources(
  env: NodeJS.ProcessEnv = process.env,
): Array<"user" | "project" | "local"> {
  const raw = (env.MILL_USER_HOOKS ?? "on").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return ["project"];
  return ["user", "project"];
}
