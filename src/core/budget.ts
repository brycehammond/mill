import {
  BudgetExceededError,
  type BudgetTracker,
  type StageName,
} from "./types.js";

export class BudgetTrackerImpl implements BudgetTracker {
  private runUsed = 0;
  private readonly stageUsed = new Map<StageName, number>();

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

  runTotal(): number {
    return this.runUsed;
  }

  stageTotal(stage: StageName): number {
    return this.stageUsed.get(stage) ?? 0;
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
    return { run: this.runUsed, byStage };
  }
}
