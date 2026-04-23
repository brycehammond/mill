import {
  BudgetExceededError,
  ZERO_USAGE,
  type BudgetTracker,
  type StageName,
  type StageRow,
  type TokenUsage,
} from "./types.js";

// Helper for stages to project a TokenUsage onto the StageRow columns
// that finishStage accepts, so the persisted row matches what the
// in-memory BudgetTracker saw.
export function usageStagePatch(
  usage: TokenUsage,
): Pick<
  StageRow,
  "input_tokens" | "cache_creation_tokens" | "cache_read_tokens" | "output_tokens"
> {
  return {
    input_tokens: usage.input,
    cache_creation_tokens: usage.cache_creation,
    cache_read_tokens: usage.cache_read,
    output_tokens: usage.output,
  };
}

export class BudgetTrackerImpl implements BudgetTracker {
  private runUsed = 0;
  private readonly stageUsed = new Map<StageName, number>();
  private runTokens: TokenUsage = { ...ZERO_USAGE };
  private readonly stageTokens = new Map<StageName, TokenUsage>();

  readonly limits: { runBudgetUsd: number; stageBudgetUsd: number };

  constructor(runBudgetUsd: number, stageBudgetUsd: number, seedRunCost = 0) {
    this.limits = { runBudgetUsd, stageBudgetUsd };
    this.runUsed = seedRunCost;
  }

  addCost(stage: StageName, cost: number): void {
    if (!Number.isFinite(cost) || cost < 0) return;
    this.runUsed += cost;
    this.stageUsed.set(stage, (this.stageUsed.get(stage) ?? 0) + cost);
  }

  addUsage(stage: StageName, usage: TokenUsage): void {
    this.runTokens = addUsage(this.runTokens, usage);
    const prev = this.stageTokens.get(stage) ?? { ...ZERO_USAGE };
    this.stageTokens.set(stage, addUsage(prev, usage));
  }

  runTotal(): number {
    return this.runUsed;
  }

  stageTotal(stage: StageName): number {
    return this.stageUsed.get(stage) ?? 0;
  }

  runUsageTotal(): TokenUsage {
    return { ...this.runTokens };
  }

  stageUsageTotal(stage: StageName): TokenUsage {
    return { ...(this.stageTokens.get(stage) ?? ZERO_USAGE) };
  }

  checkRunBudget(): void {
    if (this.runUsed > this.limits.runBudgetUsd) {
      throw new BudgetExceededError("run", this.limits.runBudgetUsd, this.runUsed);
    }
  }

  // Per-stage cap is enforced by `claude --max-budget-usd` in claude-cli.ts;
  // the harness only tallies for reporting / cross-stage run total.

  snapshot() {
    const byStage: Partial<Record<StageName, number>> = {};
    for (const [k, v] of this.stageUsed) byStage[k] = v;
    const byStageUsage: Partial<Record<StageName, TokenUsage>> = {};
    for (const [k, v] of this.stageTokens) byStageUsage[k] = { ...v };
    return {
      run: this.runUsed,
      byStage,
      runUsage: { ...this.runTokens },
      byStageUsage,
    };
  }
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + toFinite(b.input),
    cache_creation: a.cache_creation + toFinite(b.cache_creation),
    cache_read: a.cache_read + toFinite(b.cache_read),
    output: a.output + toFinite(b.output),
  };
}

function toFinite(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
