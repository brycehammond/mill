import {
  ZERO_USAGE,
  type CostTracker,
  type StageName,
  type TokenUsage,
} from "./types.js";

// In-memory cost / token-usage accumulator for a single run. Mirrors the
// numbers the SQLite `runs` / `stages` rows hold — the DB is the source
// of truth for resume; this is the live-process aggregator that stages
// read for reporting (delivery summary, pipeline result).
export class CostTrackerImpl implements CostTracker {
  private runUsed = 0;
  private readonly stageUsed = new Map<StageName, number>();
  private runTokens: TokenUsage = { ...ZERO_USAGE };
  private readonly stageTokens = new Map<StageName, TokenUsage>();

  constructor(seedRunCost = 0) {
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
