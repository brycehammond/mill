import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SqliteStateStore } from "../core/store.sqlite.js";
import {
  checkInflight,
  checkPreflight,
  monthlySpendUsd,
  startOfMonthUtc,
} from "./budget.js";

// Helpers shared across the suite — every test gets a fresh store so
// state is isolated. The :memory: connection is closed at the end of
// each test via the `using` pattern (Node 22 supports `await using`,
// but tsx targets ES2022; we just close manually).
function newStore(): SqliteStateStore {
  const s = new SqliteStateStore(":memory:");
  s.init();
  return s;
}

function seedProject(
  s: SqliteStateStore,
  opts: {
    id?: string;
    name?: string;
    rootPath?: string;
    monthlyBudgetUsd?: number | null;
  } = {},
): { id: string } {
  const id = opts.id ?? "p1";
  s.addProject({
    id,
    name: opts.name ?? "test",
    root_path: opts.rootPath ?? `/tmp/${id}`,
    monthly_budget_usd: opts.monthlyBudgetUsd ?? null,
  });
  return { id };
}

function seedRun(
  s: SqliteStateStore,
  opts: {
    id: string;
    projectId: string;
    createdAt: number;
    cost?: number;
  },
): void {
  s.createRun({
    id: opts.id,
    project_id: opts.projectId,
    status: "running",
    kind: null,
    created_at: opts.createdAt,
    requirement_path: `/tmp/${opts.id}/req.md`,
  });
  if (opts.cost && opts.cost > 0) s.addRunCost(opts.id, opts.cost);
}

describe("budget.startOfMonthUtc", () => {
  it("returns the first instant of the calendar month UTC", () => {
    const ts = startOfMonthUtc(new Date(Date.UTC(2026, 3, 26, 12, 34, 56)));
    // April 1, 2026 00:00:00 UTC.
    assert.equal(ts, Date.UTC(2026, 3, 1));
    assert.equal(new Date(ts).getUTCDate(), 1);
    assert.equal(new Date(ts).getUTCHours(), 0);
  });

  it("crosses a year boundary correctly", () => {
    const ts = startOfMonthUtc(new Date(Date.UTC(2026, 0, 15, 0, 0, 0)));
    assert.equal(ts, Date.UTC(2026, 0, 1));
  });
});

describe("budget.monthlySpendUsd", () => {
  it("sums runs created in the current month and ignores prior months", () => {
    const s = newStore();
    try {
      const { id } = seedProject(s, { monthlyBudgetUsd: 100 });
      const now = new Date(Date.UTC(2026, 3, 15));
      // In-month run.
      seedRun(s, {
        id: "r1",
        projectId: id,
        createdAt: Date.UTC(2026, 3, 10),
        cost: 4.5,
      });
      // Last month — must NOT count.
      seedRun(s, {
        id: "r2",
        projectId: id,
        createdAt: Date.UTC(2026, 2, 28),
        cost: 100,
      });
      // First instant of the month — counts (boundary inclusive).
      seedRun(s, {
        id: "r3",
        projectId: id,
        createdAt: Date.UTC(2026, 3, 1),
        cost: 0.5,
      });
      const total = monthlySpendUsd(s, id, now);
      assert.equal(total, 5.0);
    } finally {
      s.close();
    }
  });

  it("returns zero for projects with no runs", () => {
    const s = newStore();
    try {
      const { id } = seedProject(s);
      assert.equal(monthlySpendUsd(s, id), 0);
    } finally {
      s.close();
    }
  });
});

describe("budget.checkPreflight", () => {
  it("allows runs when no monthly budget is set", () => {
    const s = newStore();
    try {
      const { id } = seedProject(s);
      const r = checkPreflight(s, id);
      assert.equal(r.ok, true);
    } finally {
      s.close();
    }
  });

  it("allows runs when monthly_budget_usd is 0 (unlimited)", () => {
    const s = newStore();
    try {
      const { id } = seedProject(s, { monthlyBudgetUsd: 0 });
      const r = checkPreflight(s, id);
      assert.equal(r.ok, true);
    } finally {
      s.close();
    }
  });

  it("allows runs when current spend is below cap", () => {
    const s = newStore();
    try {
      const { id } = seedProject(s, { monthlyBudgetUsd: 10 });
      seedRun(s, {
        id: "r1",
        projectId: id,
        createdAt: Date.now(),
        cost: 9.99,
      });
      const r = checkPreflight(s, id);
      assert.equal(r.ok, true);
    } finally {
      s.close();
    }
  });

  it("denies runs when current spend has already crossed the cap", () => {
    const s = newStore();
    try {
      const { id } = seedProject(s, { monthlyBudgetUsd: 10 });
      seedRun(s, {
        id: "r1",
        projectId: id,
        createdAt: Date.now(),
        cost: 10.5,
      });
      const r = checkPreflight(s, id);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.status, 402);
        assert.equal(r.budget, 10);
        assert.ok(r.currentSpend >= 10.5 - 0.001);
        assert.match(r.reason, /budget/);
      }
    } finally {
      s.close();
    }
  });
});

describe("budget.checkInflight", () => {
  it("emits budget_warning_80 once per month, even on repeated calls", () => {
    const s = newStore();
    try {
      const { id } = seedProject(s, { monthlyBudgetUsd: 10 });
      const now = new Date(Date.UTC(2026, 3, 15));
      seedRun(s, {
        id: "r1",
        projectId: id,
        createdAt: now.getTime(),
        cost: 8.5, // 85% — over the 80% threshold.
      });
      const first = checkInflight(s, id, "r1", "implement", now);
      assert.equal(first.warned80, true);
      assert.equal(first.paused, false);

      // Second call in the same month — must not emit a duplicate.
      const second = checkInflight(s, id, "r1", "implement", now);
      assert.equal(second.warned80, false);

      // Verify only one warning event landed.
      const events = s.tailEvents("r1", 0, 100);
      const warnings = events.filter((e) => e.kind === "budget_warning_80");
      assert.equal(warnings.length, 1);
    } finally {
      s.close();
    }
  });

  it("transitions to paused_budget and emits budget_exceeded when cap is crossed", () => {
    const s = newStore();
    try {
      const { id } = seedProject(s, { monthlyBudgetUsd: 5 });
      const now = new Date(Date.UTC(2026, 3, 15));
      seedRun(s, {
        id: "r1",
        projectId: id,
        createdAt: now.getTime(),
        cost: 5.25, // over.
      });
      const r = checkInflight(s, id, "r1", "implement", now);
      assert.equal(r.paused, true);

      const run = s.getRun("r1");
      assert.equal(run?.status, "paused_budget");

      const events = s.tailEvents("r1", 0, 100);
      const exceeded = events.find((e) => e.kind === "budget_exceeded");
      assert.ok(exceeded);
    } finally {
      s.close();
    }
  });

  it("does not pause when budget is unlimited (null) or 0", () => {
    const s = newStore();
    try {
      const { id } = seedProject(s, { monthlyBudgetUsd: null });
      seedRun(s, {
        id: "r1",
        projectId: id,
        createdAt: Date.now(),
        cost: 999,
      });
      const r = checkInflight(s, id, "r1", "implement");
      assert.equal(r.paused, false);
      assert.equal(r.warned80, false);
    } finally {
      s.close();
    }
  });

  it("re-arms the warning when a new month starts", () => {
    const s = newStore();
    try {
      const { id } = seedProject(s, { monthlyBudgetUsd: 10 });

      // March cross.
      const march = new Date(Date.UTC(2026, 2, 15));
      seedRun(s, {
        id: "rMar",
        projectId: id,
        createdAt: march.getTime(),
        cost: 8.5,
      });
      const a = checkInflight(s, id, "rMar", "implement", march);
      assert.equal(a.warned80, true);

      // April cross — different month, must re-emit.
      const april = new Date(Date.UTC(2026, 3, 5));
      seedRun(s, {
        id: "rApr",
        projectId: id,
        createdAt: april.getTime(),
        cost: 8.5,
      });
      const b = checkInflight(s, id, "rApr", "implement", april);
      assert.equal(b.warned80, true);

      const aprilEvents = s.tailEvents("rApr", 0, 100);
      assert.ok(
        aprilEvents.some((e) => e.kind === "budget_warning_80"),
        "april warning should fire",
      );
    } finally {
      s.close();
    }
  });
});
