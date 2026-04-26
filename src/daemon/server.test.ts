import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { promisify } from "node:util";
import { SqliteStateStore } from "../core/store.sqlite.js";
import type { GlobalMillConfig } from "../orchestrator/config.js";
import type { ServerDeps } from "./server.js";
import { buildServer } from "./server.js";

const execFileP = promisify(execFile);

// Spin up an in-memory store + Hono app per test. The deps object stubs
// out clarify/intake so we never invoke `claude`. Routes are exercised
// via app.fetch(new Request(...)) — Hono ships that interface natively.

interface Harness {
  store: SqliteStateStore;
  app: ReturnType<typeof buildServer>;
  config: GlobalMillConfig;
  deps: ServerDeps;
  cleanup: () => Promise<void>;
}

async function makeRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `mill-daemon-${prefix}-`));
  await execFileP("git", ["init"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  await execFileP("git", ["config", "user.name", "test"], { cwd: dir });
  await execFileP("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "test\n", "utf8");
  await execFileP("git", ["add", "-A"], { cwd: dir });
  await execFileP("git", ["commit", "-m", "initial"], { cwd: dir });
  return dir;
}

function buildHarness(): Harness {
  const store = new SqliteStateStore(":memory:");
  store.init();
  const config: GlobalMillConfig = {
    millHome: "/tmp/test-mill-home",
    dbPath: ":memory:",
    daemonHost: "127.0.0.1",
    daemonPort: 7333,
    maxConcurrentRuns: 2,
    maxReviewIters: 3,
    timeoutSecPerRun: 60,
    timeoutSecPerStage: 30,
    timeoutSecPerStageOverrides: {},
    model: undefined,
  };
  // Stub deps: tests exercise routes without calling `claude`.
  // intake creates a real run row + workdir; clarify just persists a
  // canned clarification set. recordAnswers flips status to running.
  const deps: ServerDeps = {
    intake: async (args) => {
      const runId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      args.store.createRun({
        id: runId,
        project_id: args.projectId,
        status: "queued",
        kind: null,
        mode: args.mode,
        created_at: Date.now(),
        requirement_path: join(args.root, ".mill", "runs", runId, "requirement.md"),
        spec_path: null,
      });
      return {
        runId,
        requirementPath: join(args.root, ".mill", "runs", runId, "requirement.md"),
        mode: args.mode,
        branch: null,
        baseBranch: null,
      };
    },
    buildContext: async ({ runId, store }) => ({
      runId,
      projectId: "test",
      kind: null,
      mode: "new",
      // The clarify/recordAnswers stubs don't read paths, but the real
      // signature requires them — fill with placeholders.
      paths: {} as never,
      store: store!,
      abortController: new AbortController(),
      costs: {} as never,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => ({} as never),
      },
      model: undefined,
      root: "/tmp",
      stateDir: "/tmp",
      stageTimeoutMs: 60_000,
      stageTimeoutsMs: {},
    }),
    clarify: async (ctx) => {
      ctx.store.saveClarifications(ctx.runId, {
        kind: "cli",
        questions: [
          { id: "q1", question: "what?", why: "needed", default: "yes" },
        ],
      });
      return { ok: true, cost: 0 };
    },
    recordAnswers: async (ctx, answers) => {
      const existing = ctx.store.getClarifications(ctx.runId);
      if (!existing) throw new Error("no clarifications");
      ctx.store.saveClarifications(ctx.runId, { ...existing, answers });
      ctx.store.updateRun(ctx.runId, { status: "running" });
    },
  };
  const app = buildServer({ store, config, deps });
  return {
    store,
    app,
    config,
    deps,
    cleanup: async () => {
      store.close();
    },
  };
}

function parseSseFrames(
  text: string,
): { id: string; event: string; data: string }[] {
  const frames: { id: string; event: string; data: string }[] = [];
  // SSE frames are delimited by a blank line. We tolerate \r\n and \n.
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let id = "";
    let event = "";
    let data = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (id || event || data) frames.push({ id, event, data });
  }
  return frames;
}

async function fetchJson(
  app: ReturnType<typeof buildServer>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await app.fetch(new Request(`http://localhost${path}`, init));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // leave raw text
  }
  return { status: res.status, body: parsed };
}

describe("daemon server", () => {
  let repo: string;
  let h: Harness;

  before(async () => {
    repo = await makeRepo("server");
  });

  after(async () => {
    if (h) await h.cleanup();
  });

  it("GET /healthz reports liveness", async () => {
    h = buildHarness();
    const res = await fetchJson(h.app, "GET", "/healthz");
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; pid: number; uptime_s: number };
    assert.equal(body.ok, true);
    assert.equal(body.pid, process.pid);
    assert.ok(typeof body.uptime_s === "number");
    await h.cleanup();
  });

  it("POST /projects registers a repo and returns the row", async () => {
    h = buildHarness();
    const res = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
      monthly_budget_usd: 100,
    });
    assert.equal(res.status, 200);
    const body = res.body as {
      project: { id: string; root_path: string; monthly_budget_usd: number };
      created: boolean;
    };
    assert.equal(body.created, true);
    // git rev-parse --show-toplevel canonicalizes through /private on
    // macOS (the temp dir is symlinked), so we just check suffix
    // equivalence rather than exact equality.
    assert.ok(body.project.root_path.endsWith(repo) || body.project.root_path === repo);
    assert.equal(body.project.monthly_budget_usd, 100);

    // Idempotent re-add.
    const res2 = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    assert.equal(res2.status, 200);
    assert.equal((res2.body as { created: boolean }).created, false);
    await h.cleanup();
  });

  it("POST /projects 400s without root_path", async () => {
    h = buildHarness();
    const res = await fetchJson(h.app, "POST", "/projects", {});
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /root_path/);
    await h.cleanup();
  });

  it("GET /projects lists registered projects with rollups", async () => {
    h = buildHarness();
    await fetchJson(h.app, "POST", "/projects", { root_path: repo });
    const res = await fetchJson(h.app, "GET", "/projects");
    assert.equal(res.status, 200);
    const list = res.body as Array<{
      id: string;
      cost_today_usd: number;
      cost_mtd_usd: number;
      in_flight_runs: number;
      last_delivery_ts: number | null;
    }>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.cost_today_usd, 0);
    assert.equal(list[0]!.in_flight_runs, 0);
    assert.equal(list[0]!.last_delivery_ts, null);
    await h.cleanup();
  });

  it("GET /projects?include_removed=1 surfaces soft-deleted projects", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    await fetchJson(h.app, "DELETE", `/projects/${projectId}`);

    const hidden = await fetchJson(h.app, "GET", "/projects");
    assert.equal((hidden.body as unknown[]).length, 0);

    const visible = await fetchJson(
      h.app,
      "GET",
      "/projects?include_removed=1",
    );
    assert.equal((visible.body as unknown[]).length, 1);
    await h.cleanup();
  });

  it("GET /projects/:id 404s on unknown id", async () => {
    h = buildHarness();
    const res = await fetchJson(h.app, "GET", "/projects/does-not-exist");
    assert.equal(res.status, 404);
    await h.cleanup();
  });

  it("DELETE /projects/:id soft-deletes and stamps removed_at", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const del = await fetchJson(h.app, "DELETE", `/projects/${projectId}`);
    assert.equal(del.status, 200);
    const body = del.body as {
      project: { removed_at: number | null };
      removed: boolean;
    };
    assert.equal(body.removed, true);
    assert.notEqual(body.project.removed_at, null);
    await h.cleanup();
  });

  it("POST /projects/:id/runs all_defaults=true triggers running status", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const res = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "build a thing",
      all_defaults: true,
    });
    assert.equal(res.status, 200);
    const body = res.body as {
      run_id: string;
      status: string;
      clarifications: unknown;
    };
    assert.equal(body.status, "running");
    assert.equal(body.clarifications, null);

    // Verify the run row exists with the right project_id.
    const runRow = h.store.getRun(body.run_id);
    assert.ok(runRow);
    assert.equal(runRow.project_id, projectId);
    assert.equal(runRow.status, "running");
    await h.cleanup();
  });

  it("POST /projects/:id/runs without all_defaults returns clarifications and stays awaiting", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const res = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "do a thing",
    });
    assert.equal(res.status, 200);
    const body = res.body as {
      run_id: string;
      status: string;
      clarifications: { kind: string; questions: { id: string }[] } | null;
    };
    assert.equal(body.status, "awaiting_clarification");
    assert.ok(body.clarifications);
    assert.equal(body.clarifications.questions.length, 1);

    const runRow = h.store.getRun(body.run_id);
    assert.equal(runRow?.status, "awaiting_clarification");
    await h.cleanup();
  });

  it("POST /runs/:id/clarifications transitions to running", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const created2 = await fetchJson(
      h.app,
      "POST",
      `/projects/${projectId}/runs`,
      { requirement: "do a thing" },
    );
    const runId = (created2.body as { run_id: string }).run_id;

    // Object-shape answers
    const ans = await fetchJson(
      h.app,
      "POST",
      `/runs/${runId}/clarifications`,
      { answers: { q1: "yes" } },
    );
    assert.equal(ans.status, 200);
    assert.equal(h.store.getRun(runId)?.status, "running");
    await h.cleanup();
  });

  it("POST /runs/:id/clarifications also accepts array form", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const created2 = await fetchJson(
      h.app,
      "POST",
      `/projects/${projectId}/runs`,
      { requirement: "do a thing" },
    );
    const runId = (created2.body as { run_id: string }).run_id;
    const res = await fetchJson(
      h.app,
      "POST",
      `/runs/${runId}/clarifications`,
      { answers: [{ question_id: "q1", answer: "yes" }] },
    );
    assert.equal(res.status, 200);
    await h.cleanup();
  });

  it("GET /runs filters by project + status", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "build A",
      all_defaults: true,
    });
    await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "build B",
      all_defaults: true,
    });

    const all = await fetchJson(h.app, "GET", `/runs?project=${projectId}`);
    assert.equal((all.body as unknown[]).length, 2);

    const running = await fetchJson(
      h.app,
      "GET",
      `/runs?project=${projectId}&status=running`,
    );
    assert.equal((running.body as unknown[]).length, 2);

    const done = await fetchJson(
      h.app,
      "GET",
      `/runs?project=${projectId}&status=completed`,
    );
    assert.equal((done.body as unknown[]).length, 0);
    await h.cleanup();
  });

  it("GET /runs/:id returns run + stages + findings counts", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const r = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "build A",
      all_defaults: true,
    });
    const runId = (r.body as { run_id: string }).run_id;
    h.store.insertFinding({
      run_id: runId,
      iteration: 1,
      critic: "security",
      severity: "HIGH",
      title: "leak",
      detail_path: "/tmp/sec.md",
    });
    const detail = await fetchJson(h.app, "GET", `/runs/${runId}`);
    assert.equal(detail.status, 200);
    const body = detail.body as {
      run: { id: string };
      stages: unknown[];
      findings_counts: { HIGH: number; total: number };
    };
    assert.equal(body.run.id, runId);
    assert.equal(body.findings_counts.HIGH, 1);
    assert.equal(body.findings_counts.total, 1);
    await h.cleanup();
  });

  it("GET /runs/:id/events tails new events since cursor", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const r = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "build A",
      all_defaults: true,
    });
    const runId = (r.body as { run_id: string }).run_id;
    h.store.appendEvent(runId, "spec", "started", { hello: 1 });
    h.store.appendEvent(runId, "spec", "ended", { hello: 2 });
    const all = await fetchJson(h.app, "GET", `/runs/${runId}/events`);
    const events = (all.body as { events: { id: number }[] }).events;
    assert.equal(events.length, 2);
    const sinceFirst = await fetchJson(
      h.app,
      "GET",
      `/runs/${runId}/events?since=${events[0]!.id}`,
    );
    assert.equal(
      (sinceFirst.body as { events: unknown[] }).events.length,
      1,
    );
    await h.cleanup();
  });

  it("POST /runs/:id/resume flips a non-terminal run back to running", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const r = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "build A",
      all_defaults: true,
    });
    const runId = (r.body as { run_id: string }).run_id;
    // The run is "running" already; simulate a worker crash by flipping
    // it to "queued" — resume should bring it back to running.
    h.store.updateRun(runId, { status: "queued" });
    const res = await fetchJson(h.app, "POST", `/runs/${runId}/resume`);
    assert.equal(res.status, 200);
    assert.equal(h.store.getRun(runId)?.status, "running");
    await h.cleanup();
  });

  it("POST /runs/:id/resume 400s on terminal states", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const r = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "build A",
      all_defaults: true,
    });
    const runId = (r.body as { run_id: string }).run_id;
    h.store.updateRun(runId, { status: "completed" });
    const res = await fetchJson(h.app, "POST", `/runs/${runId}/resume`);
    assert.equal(res.status, 400);
    await h.cleanup();
  });

  it("POST /runs/:id/resume 400s on awaiting_clarification", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const r = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "build A",
    });
    const runId = (r.body as { run_id: string }).run_id;
    const res = await fetchJson(h.app, "POST", `/runs/${runId}/resume`);
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /clarification/);
    await h.cleanup();
  });

  it("POST /runs/:id/kill writes the sentinel and marks killed", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const r = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "build A",
      all_defaults: true,
    });
    const runId = (r.body as { run_id: string }).run_id;
    const kill = await fetchJson(h.app, "POST", `/runs/${runId}/kill`);
    assert.equal(kill.status, 200);
    const body = kill.body as { killed_path: string; status: string };
    assert.equal(body.status, "killed");
    const sentinel = await readFile(body.killed_path, "utf8");
    assert.match(sentinel, /killed at /);
    assert.equal(h.store.getRun(runId)?.status, "killed");
    await h.cleanup();
  });

  it("POST /runs/:id/kill 404s on unknown run", async () => {
    h = buildHarness();
    const res = await fetchJson(h.app, "POST", "/runs/nope/kill");
    assert.equal(res.status, 404);
    await h.cleanup();
  });

  it("GET /api/v1/dashboard aggregates across projects", async () => {
    h = buildHarness();
    // Create two projects (need a second repo for the second one).
    const repo2 = await makeRepo("dash");
    const a = await fetchJson(h.app, "POST", "/projects", { root_path: repo });
    const b = await fetchJson(h.app, "POST", "/projects", { root_path: repo2 });
    const aId = (a.body as { project: { id: string } }).project.id;
    const bId = (b.body as { project: { id: string } }).project.id;
    // Two runs in project A: one running, one completed with cost.
    const ra = await fetchJson(h.app, "POST", `/projects/${aId}/runs`, {
      requirement: "thing 1",
      all_defaults: true,
    });
    const raId = (ra.body as { run_id: string }).run_id;
    h.store.updateRun(raId, { status: "completed" });
    h.store.addRunCost(raId, 1.5);

    const rb = await fetchJson(h.app, "POST", `/projects/${aId}/runs`, {
      requirement: "thing 2",
      all_defaults: true,
    });
    void rb;

    // One queued run in project B.
    const rc = await fetchJson(h.app, "POST", `/projects/${bId}/runs`, {
      requirement: "thing 3",
      all_defaults: true,
    });
    h.store.updateRun(
      (rc.body as { run_id: string }).run_id,
      { status: "queued" },
    );

    const dash = await fetchJson(h.app, "GET", "/api/v1/dashboard");
    assert.equal(dash.status, 200);
    const body = dash.body as {
      cost_today_usd: number;
      runs_in_flight: number;
      project_count: number;
      projects: { id: string; in_flight_runs: number }[];
    };
    assert.equal(body.project_count, 2);
    assert.equal(body.runs_in_flight, 2);
    assert.ok(body.cost_today_usd >= 1.5);
    const aDash = body.projects.find((p) => p.id === aId);
    assert.ok(aDash);
    assert.equal(aDash.in_flight_runs, 1);
    await h.cleanup();
  });

  it("GET /api/v1/projects/:id/findings filters to project", async () => {
    h = buildHarness();
    const repo2 = await makeRepo("findings-scope");
    const a = await fetchJson(h.app, "POST", "/projects", { root_path: repo });
    const b = await fetchJson(h.app, "POST", "/projects", { root_path: repo2 });
    const aId = (a.body as { project: { id: string } }).project.id;
    const bId = (b.body as { project: { id: string } }).project.id;

    const ra = await fetchJson(h.app, "POST", `/projects/${aId}/runs`, {
      requirement: "x",
      all_defaults: true,
    });
    const aRunId = (ra.body as { run_id: string }).run_id;
    h.store.insertFinding({
      run_id: aRunId,
      iteration: 1,
      critic: "ux",
      severity: "MEDIUM",
      title: "A finding",
      detail_path: "/tmp/a.md",
    });

    const rb = await fetchJson(h.app, "POST", `/projects/${bId}/runs`, {
      requirement: "y",
      all_defaults: true,
    });
    const bRunId = (rb.body as { run_id: string }).run_id;
    h.store.insertFinding({
      run_id: bRunId,
      iteration: 1,
      critic: "security",
      severity: "HIGH",
      title: "B finding",
      detail_path: "/tmp/b.md",
    });

    const aRes = await fetchJson(h.app, "GET", `/api/v1/projects/${aId}/findings`);
    assert.equal(aRes.status, 200);
    const aBody = (aRes.body as { entries: { fingerprint: string }[] }).entries;
    assert.equal(aBody.length, 1);
    assert.match(aBody[0]!.fingerprint, /^ux\|MEDIUM\|/);

    const bRes = await fetchJson(h.app, "GET", `/api/v1/projects/${bId}/findings`);
    const bBody = (bRes.body as { entries: { fingerprint: string }[] }).entries;
    assert.equal(bBody.length, 1);
    assert.match(bBody[0]!.fingerprint, /^security\|HIGH\|/);
    await h.cleanup();
  });

  it("/api/v1/findings/suppressed CRUD round-trips", async () => {
    h = buildHarness();
    const fp = "ux|MEDIUM|missing copy";
    const post = await fetchJson(h.app, "POST", "/api/v1/findings/suppressed", {
      fingerprint: fp,
      note: "duplicate of #42",
    });
    assert.equal(post.status, 200);
    const list = await fetchJson(h.app, "GET", "/api/v1/findings/suppressed");
    const entries = (list.body as { entries: { fingerprint: string; note: string | null }[] })
      .entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.fingerprint, fp);
    assert.equal(entries[0]!.note, "duplicate of #42");

    const del = await fetchJson(
      h.app,
      "DELETE",
      `/api/v1/findings/suppressed/${encodeURIComponent(fp)}`,
    );
    assert.equal(del.status, 200);
    const after = await fetchJson(h.app, "GET", "/api/v1/findings/suppressed");
    assert.equal((after.body as { entries: unknown[] }).entries.length, 0);
    await h.cleanup();
  });

  it("/api/v1/findings/suppressed POST 400s without fingerprint", async () => {
    h = buildHarness();
    const res = await fetchJson(h.app, "POST", "/api/v1/findings/suppressed", {});
    assert.equal(res.status, 400);
    await h.cleanup();
  });

  it("GET /api/v1/runs/:id/events streams replay then live frames", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const r = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "x",
      all_defaults: true,
    });
    const runId = (r.body as { run_id: string }).run_id;

    // Pre-populate two events so the catch-up has something to replay.
    h.store.appendEvent(runId, "spec", "stage_started", { i: 1 });
    h.store.appendEvent(runId, "spec", "stage_completed", { i: 2 });

    const res = await h.app.fetch(
      new Request(`http://localhost/api/v1/runs/${runId}/events`),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const buf: string[] = [];

    // Read until we've seen both backlog events plus one live event,
    // then cancel the stream. parseSseFrames is tolerant of partial
    // chunks; we accumulate text and split on the SSE frame boundary.
    let pushedLive = false;
    const collected: { id: string; event: string; data: string }[] = [];
    while (collected.length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buf.push(decoder.decode(value, { stream: true }));
      const text = buf.join("");
      const frames = parseSseFrames(text);
      // Replace all collected with current parse so we don't double-count.
      collected.length = 0;
      for (const f of frames) collected.push(f);
      // Once both backlog frames are in, fire one live event.
      if (collected.length >= 2 && !pushedLive) {
        pushedLive = true;
        h.store.appendEvent(runId, "spec", "stage_iteration", { live: true });
      }
    }
    await reader.cancel();

    assert.ok(collected.length >= 3);
    // First two are the backlog rows, in id order. `kind` lives in
    // the JSON payload (we don't set the SSE `event:` field).
    const first = JSON.parse(collected[0]!.data) as { kind: string; id: number };
    const second = JSON.parse(collected[1]!.data) as { kind: string; id: number };
    const third = JSON.parse(collected[2]!.data) as {
      kind: string;
      id: number;
      payload: { live: boolean };
    };
    assert.equal(first.kind, "stage_started");
    assert.equal(second.kind, "stage_completed");
    assert.equal(third.kind, "stage_iteration");
    // ids monotonic, surfaced both in payload and as SSE `id:` line.
    assert.ok(first.id < second.id);
    assert.ok(second.id < third.id);
    assert.equal(Number(collected[0]!.id), first.id);
    assert.equal(third.payload.live, true);
    await h.cleanup();
  });

  it("GET /api/v1/runs/:id/events with Last-Event-ID skips the backlog", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const r = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "x",
      all_defaults: true,
    });
    const runId = (r.body as { run_id: string }).run_id;
    h.store.appendEvent(runId, "spec", "a", null);
    h.store.appendEvent(runId, "spec", "b", null);
    const events = h.store.tailEvents(runId);
    const cutoff = events[0]!.id;

    const res = await h.app.fetch(
      new Request(`http://localhost/api/v1/runs/${runId}/events`, {
        headers: { "last-event-id": String(cutoff) },
      }),
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const buf: string[] = [];
    let collected: { id: string; event: string; data: string }[] = [];
    while (collected.length < 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buf.push(decoder.decode(value, { stream: true }));
      collected = parseSseFrames(buf.join(""));
    }
    await reader.cancel();
    // Only the second event ("b") replays after cutoff.
    assert.equal(collected.length, 1);
    const payload = JSON.parse(collected[0]!.data) as { kind: string };
    assert.equal(payload.kind, "b");
    await h.cleanup();
  });

  it("GET /api/v1/runs/:id/events 404s on unknown run", async () => {
    h = buildHarness();
    const res = await h.app.fetch(
      new Request("http://localhost/api/v1/runs/nope/events"),
    );
    assert.equal(res.status, 404);
    await h.cleanup();
  });

  it("GET /findings returns ledger entries (cross-project default)", async () => {
    h = buildHarness();
    const created = await fetchJson(h.app, "POST", "/projects", {
      root_path: repo,
    });
    const projectId = (created.body as { project: { id: string } }).project.id;
    const r = await fetchJson(h.app, "POST", `/projects/${projectId}/runs`, {
      requirement: "x",
      all_defaults: true,
    });
    const runId = (r.body as { run_id: string }).run_id;
    h.store.insertFinding({
      run_id: runId,
      iteration: 1,
      critic: "ux",
      severity: "MEDIUM",
      title: "missing copy",
      detail_path: "/tmp/ux.md",
    });
    const res = await fetchJson(h.app, "GET", "/findings");
    const entries = (res.body as { entries: { fingerprint: string }[] })
      .entries;
    assert.equal(entries.length, 1);
    assert.match(entries[0]!.fingerprint, /^ux\|MEDIUM\|/);

    // Filtered by project — same result here, since there's only one
    // project and the fingerprint belongs to it.
    const filtered = await fetchJson(h.app, "GET", `/findings?project=${projectId}`);
    assert.equal(
      (filtered.body as { entries: unknown[] }).entries.length,
      1,
    );

    // Filtered by a different project id — empty.
    const empty = await fetchJson(h.app, "GET", "/findings?project=other-id");
    assert.equal((empty.body as { entries: unknown[] }).entries.length, 0);
    await h.cleanup();
  });
});
