import { writeFile } from "node:fs/promises";
import { Hono } from "hono";
import {
  addProject,
  ensureRunDirs,
  resolveProjectByIdentifier,
  runPaths,
  type CriticName,
  type LedgerEntry,
  type ProjectRow,
  type RunMode,
  type RunRow,
  type RunStatus,
  type Severity,
  type StateStore,
} from "../core/index.js";
import { intake, recordAnswers } from "../orchestrator/index.js";
import { buildContext } from "../orchestrator/context.js";
import { clarify } from "../orchestrator/stages/clarify.js";
import type { GlobalMillConfig } from "../orchestrator/config.js";
import { buildSseHandler } from "./sse.js";
import { buildStaticHandler } from "./static.js";

// Minimal HTTP API the CLI talks to. All routes are JSON, loopback-only;
// no auth, no CORS. Schemas are validated by hand (no Zod) to keep the
// route layer dependency-light. The daemon process owns one StateStore
// instance — every handler closes over it.

export interface BuildServerArgs {
  store: StateStore;
  config: GlobalMillConfig;
  // Optional: dependency-injected for tests so the server can be exercised
  // without spawning real `claude` subprocesses. Defaults to the real
  // pipeline imports.
  deps?: ServerDeps;
  // When true (default in production), serve the built UI bundle from
  // dist/web/ at non-API paths. Disabled by --no-ui or MILL_DEV.
  serveUi?: boolean;
}

export interface ServerDeps {
  intake: typeof intake;
  buildContext: typeof buildContext;
  clarify: typeof clarify;
  recordAnswers: typeof recordAnswers;
}

const REAL_DEPS: ServerDeps = {
  intake,
  buildContext,
  clarify,
  recordAnswers,
};

// Handlers throw HttpError(status, message) to signal non-200 responses;
// uncaught Errors become 500. The wrapper keeps each route body compact.
type ContentfulStatus = 200 | 400 | 404 | 409 | 500;

class HttpError extends Error {
  constructor(public readonly status: ContentfulStatus, message: string) {
    super(message);
  }
}

function httpError(status: ContentfulStatus, message: string): never {
  throw new HttpError(status, message);
}

export function buildServer(args: BuildServerArgs): Hono {
  const { store, config } = args;
  const deps = args.deps ?? REAL_DEPS;
  const app = new Hono();
  const startedAt = Date.now();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status);
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  });

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      pid: process.pid,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      port: config.daemonPort,
      host: config.daemonHost,
    }),
  );

  // ---- projects ----

  app.post("/projects", async (c) => {
    const body = await readJsonBody(c);
    const rootPath = stringField(body, "root_path");
    if (!rootPath) httpError(400, "root_path is required");
    // addProject runs `migrateLegacyMill` internally on first insert
    // (when `created === true`), idempotent via a marker file in the
    // legacy `.mill/` dir. Re-adds skip migration entirely. The result's
    // `migration` field is populated only when migration actually ran.
    const result = await addProject(store, {
      rootPath,
      name: stringField(body, "name") ?? undefined,
      monthlyBudgetUsd: numField(body, "monthly_budget_usd"),
      defaultConcurrency: intField(body, "default_concurrency"),
    });
    return c.json({
      project: enrichProject(store, result.project),
      created: result.created,
      migration: result.migration ?? { migrated: false },
    });
  });

  app.get("/projects", (c) => {
    const includeRemoved = c.req.query("include_removed") === "1";
    const rows = store.listProjects({ includeRemoved });
    const enriched = rows.map((p) => enrichProject(store, p));
    return c.json(enriched);
  });

  app.get("/projects/:id", (c) => {
    const id = c.req.param("id");
    const project = resolveProjectByIdentifier(store, id);
    if (!project) httpError(404, `project not found: ${id}`);
    return c.json(enrichProject(store, project));
  });

  app.delete("/projects/:id", (c) => {
    const id = c.req.param("id");
    const project = resolveProjectByIdentifier(store, id);
    if (!project) httpError(404, `project not found: ${id}`);
    store.removeProject(project.id);
    const updated = store.getProject(project.id);
    return c.json({ project: updated, removed: true });
  });

  // ---- runs (project-scoped create) ----

  app.post("/projects/:id/runs", async (c) => {
    const id = c.req.param("id");
    const project = resolveProjectByIdentifier(store, id);
    if (!project) httpError(404, `project not found: ${id}`);
    if (project.removed_at !== null) {
      httpError(400, `project ${project.id} is removed`);
    }
    const body = await readJsonBody(c);
    const requirement = stringField(body, "requirement");
    if (!requirement) httpError(400, "requirement is required");

    const rawMode = stringField(body, "mode");
    const mode = parseMode(rawMode);
    if (mode === "invalid") {
      httpError(400, `mode must be one of new|edit, got ${rawMode}`);
    }

    // Run the existing intake flow against the project's repo.
    // This creates the run row (status=queued), writes the requirement
    // file, and (in edit mode) creates a worktree.
    const intakeResult = await deps.intake({
      requirement,
      root: project.root_path,
      store,
      mode,
      projectId: project.id,
    });

    // Always run clarify inline so the caller can decide whether to ask
    // the user or auto-accept defaults. recordAnswers transitions the
    // run to "running" (the daemon's run loop picks it up).
    const ctx = await deps.buildContext({
      runId: intakeResult.runId,
      config,
      store,
    });
    const clarifyResult = await deps.clarify(ctx);
    if (!clarifyResult.ok) {
      httpError(500, `clarify failed: ${clarifyResult.error}`);
    }
    const clar = store.getClarifications(intakeResult.runId);
    if (!clar) httpError(500, "clarifications not stored after clarify");

    // Mark the run as awaiting clarification so observers know it's
    // blocked on user input. recordAnswers will flip back to "running".
    store.updateRun(intakeResult.runId, {
      status: "awaiting_clarification",
    });

    // --all-defaults: skip the round-trip and accept every default.
    if (boolField(body, "all_defaults")) {
      const answers: Record<string, string> = {};
      for (const q of clar.questions) {
        answers[q.id] = q.default ?? "";
      }
      await deps.recordAnswers(ctx, answers);
      return c.json({
        run_id: intakeResult.runId,
        mode: intakeResult.mode,
        branch: intakeResult.branch,
        base_branch: intakeResult.baseBranch,
        status: "running",
        clarifications: null,
      });
    }

    return c.json({
      run_id: intakeResult.runId,
      mode: intakeResult.mode,
      branch: intakeResult.branch,
      base_branch: intakeResult.baseBranch,
      status: "awaiting_clarification",
      clarifications: clar,
    });
  });

  app.post("/runs/:id/clarifications", async (c) => {
    const runId = c.req.param("id");
    const run = store.getRun(runId);
    if (!run) httpError(404, `run not found: ${runId}`);
    const body = await readJsonBody(c);
    const answers = parseAnswers(body);
    if (!answers) {
      httpError(
        400,
        "answers must be { [question_id]: answer } or [{ question_id, answer }]",
      );
    }
    const ctx = await deps.buildContext({ runId, config, store });
    await deps.recordAnswers(ctx, answers);
    return c.json({ run_id: runId, status: "running" });
  });

  app.get("/runs", (c) => {
    const projectId = c.req.query("project");
    const status = c.req.query("status") as RunStatus | undefined;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const opts: { status?: RunStatus; limit?: number; projectId?: string } = {};
    if (projectId) opts.projectId = projectId;
    if (status) opts.status = status;
    if (limit && Number.isFinite(limit)) opts.limit = limit;
    return c.json(store.listRuns(opts));
  });

  app.get("/runs/:id", (c) => {
    const runId = c.req.param("id");
    const run = store.getRun(runId);
    if (!run) httpError(404, `run not found: ${runId}`);
    const stages = store.listDisplayStages(runId);
    const findings = store.listFindings(runId);
    const findingsCounts = countFindings(findings);
    return c.json({
      run,
      stages,
      findings_counts: findingsCounts,
    });
  });

  app.get("/runs/:id/events", (c) => {
    const runId = c.req.param("id");
    const since = Number(c.req.query("since") ?? "0") || 0;
    const limit = Number(c.req.query("limit") ?? "200") || 200;
    const events = store.tailEvents(runId, since, limit);
    return c.json({ events });
  });

  app.post("/runs/:id/resume", (c) => {
    const runId = c.req.param("id");
    const run = store.getRun(runId);
    if (!run) httpError(404, `run not found: ${runId}`);
    // Terminal states are not resumable. `completed` is by design;
    // `failed` and `killed` need explicit human action (clear the
    // KILLED sentinel, fix the underlying issue) before retrying — the
    // daemon shouldn't silently retry them.
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "killed"
    ) {
      httpError(
        400,
        `run ${runId} is in terminal state ${run.status} and cannot be resumed`,
      );
    }
    if (run.status === "awaiting_clarification") {
      httpError(
        400,
        `run ${runId} is awaiting clarifications — submit answers via POST /runs/:id/clarifications`,
      );
    }
    // queued or running → flip to running so the run loop picks it up
    // on the next poll. Idempotent: a row already running stays running.
    store.updateRun(runId, { status: "running" });
    return c.json({ run_id: runId, status: "running" });
  });

  app.post("/runs/:id/kill", async (c) => {
    const runId = c.req.param("id");
    const run = store.getRun(runId);
    if (!run) httpError(404, `run not found: ${runId}`);
    if (!run.project_id) {
      httpError(400, `run ${runId} has no project_id (legacy row?)`);
    }
    const project = store.getProject(run.project_id);
    if (!project) {
      httpError(500, `project ${run.project_id} not found for run ${runId}`);
    }
    const paths = runPaths(project.root_path, runId);
    // Make sure the run dir exists before writing the sentinel — a run
    // killed before any stage started may not have it yet.
    await ensureRunDirs(paths, { createWorkdir: false });
    await writeFile(
      paths.killed,
      `killed at ${new Date().toISOString()}\n`,
      "utf8",
    );
    store.updateRun(runId, { status: "killed" });
    return c.json({ run_id: runId, killed_path: paths.killed, status: "killed" });
  });

  app.get("/findings", (c) => {
    const projectId = c.req.query("project");
    const limit = Number(c.req.query("limit") ?? "200") || 200;
    const minRuns = Number(c.req.query("min_runs") ?? "1") || 1;
    const includeSuppressed = c.req.query("include_suppressed") === "1";
    // The store's listLedgerEntries doesn't filter by project. Pull the
    // unfiltered list and post-filter in memory using the run rows we
    // already have; for ~hundreds of fingerprints this is cheap.
    const entries = store.listLedgerEntries({
      minRuns,
      includeSuppressed,
      limit,
    });
    if (!projectId) return c.json({ entries });
    const filtered = filterLedgerByProject(store, entries, projectId);
    return c.json({ entries: filtered });
  });

  // ---- /api/v1 surface (Phase 2) ----
  // The unprefixed routes above are the Phase 1 contract that the CLI
  // client speaks. The /api/v1 surface adds the routes the web UI
  // needs (SSE stream, dashboard aggregate, suppressed-fingerprint
  // CRUD, project-scoped findings) without modifying any Phase 1
  // path. Existing routes stay stable; new ones live under /api/v1.

  app.get("/api/v1/runs/:id/events", buildSseHandler({ store }));

  app.get("/api/v1/dashboard", (c) => c.json(buildDashboard(store)));

  app.get("/api/v1/projects/:id/findings", (c) => {
    const id = c.req.param("id");
    const project = resolveProjectByIdentifier(store, id);
    if (!project) httpError(404, `project not found: ${id}`);
    const limit = Number(c.req.query("limit") ?? "200") || 200;
    const minRuns = Number(c.req.query("min_runs") ?? "1") || 1;
    const includeSuppressed = c.req.query("include_suppressed") === "1";
    const entries = store.listLedgerEntries({
      minRuns,
      includeSuppressed,
      limit,
    });
    return c.json({
      entries: filterLedgerByProject(store, entries, project.id),
    });
  });

  app.get("/api/v1/findings/suppressed", (c) =>
    c.json({ entries: store.listSuppressedFingerprints() }),
  );

  app.post("/api/v1/findings/suppressed", async (c) => {
    const body = await readJsonBody(c);
    const fingerprint = stringField(body, "fingerprint");
    if (!fingerprint) httpError(400, "fingerprint is required");
    const note = stringField(body, "note");
    store.suppressFingerprint(fingerprint, note ?? undefined);
    return c.json({ fingerprint, suppressed: true });
  });

  app.delete("/api/v1/findings/suppressed/:fingerprint", (c) => {
    const fingerprint = c.req.param("fingerprint");
    if (!fingerprint) httpError(400, "fingerprint required");
    store.unsuppressFingerprint(fingerprint);
    return c.json({ fingerprint, suppressed: false });
  });

  // Static UI lives last so API routes always match first. The static
  // handler also serves the SPA fallback for unknown non-API paths.
  if (args.serveUi !== false) {
    const staticHandler = buildStaticHandler();
    if (staticHandler) {
      app.get("/", staticHandler);
      app.get("/assets/*", staticHandler);
      app.get("*", staticHandler);
    }
  }

  return app;
}

function buildDashboard(store: StateStore): Dashboard {
  const projects = store.listProjects();
  const todayStart = startOfTodayMs();
  const monthStart = startOfMonthMs();
  let costToday = 0;
  let costMtd = 0;
  let runsInFlight = 0;
  const perProject: DashboardProject[] = [];
  for (const p of projects) {
    const runs = store.listRuns({ projectId: p.id, limit: 10_000 });
    let pToday = 0;
    let pMtd = 0;
    let pInFlight = 0;
    let pLastDelivery: number | null = null;
    let pLastStatus: RunStatus | null = null;
    let pLastTs = -Infinity;
    for (const r of runs) {
      if (r.created_at >= todayStart) pToday += r.total_cost_usd;
      if (r.created_at >= monthStart) pMtd += r.total_cost_usd;
      if (r.status === "running" || r.status === "queued") pInFlight += 1;
      if (r.status === "completed") {
        if (pLastDelivery === null || r.created_at > pLastDelivery) {
          pLastDelivery = r.created_at;
        }
      }
      if (r.created_at > pLastTs) {
        pLastTs = r.created_at;
        pLastStatus = r.status;
      }
    }
    costToday += pToday;
    costMtd += pMtd;
    runsInFlight += pInFlight;
    perProject.push({
      id: p.id,
      name: p.name,
      root_path: p.root_path,
      cost_today_usd: pToday,
      cost_mtd_usd: pMtd,
      in_flight_runs: pInFlight,
      last_delivery_ts: pLastDelivery,
      last_run_status: pLastStatus,
    });
  }
  const ledger = store.listLedgerEntries({ minRuns: 2, limit: 20 });
  return {
    cost_today_usd: costToday,
    cost_mtd_usd: costMtd,
    runs_in_flight: runsInFlight,
    project_count: projects.length,
    projects: perProject,
    top_recurring_findings: ledger,
  };
}

interface DashboardProject {
  id: string;
  name: string;
  root_path: string;
  cost_today_usd: number;
  cost_mtd_usd: number;
  in_flight_runs: number;
  last_delivery_ts: number | null;
  last_run_status: RunStatus | null;
}

interface Dashboard {
  cost_today_usd: number;
  cost_mtd_usd: number;
  runs_in_flight: number;
  project_count: number;
  projects: DashboardProject[];
  top_recurring_findings: LedgerEntry[];
}

// ---- helpers ----

interface EnrichedProject extends ProjectRow {
  cost_today_usd: number;
  cost_mtd_usd: number;
  in_flight_runs: number;
  last_delivery_ts: number | null;
}

function enrichProject(store: StateStore, p: ProjectRow): EnrichedProject {
  // Pull all runs for this project once and fold the rollups locally — a
  // project with thousands of runs would warrant a SQL aggregate, but
  // for Phase 1 this is fine and keeps the store interface stable.
  const runs = store.listRuns({ projectId: p.id, limit: 10_000 });
  const todayStart = startOfTodayMs();
  const monthStart = startOfMonthMs();
  let costToday = 0;
  let costMtd = 0;
  let inFlight = 0;
  let lastDelivery: number | null = null;
  for (const r of runs) {
    if (r.created_at >= todayStart) costToday += r.total_cost_usd;
    if (r.created_at >= monthStart) costMtd += r.total_cost_usd;
    if (r.status === "running" || r.status === "queued") inFlight += 1;
    if (r.status === "completed") {
      // Use created_at as the "delivery" ts in Phase 1 — the deliver
      // stage's finished_at would be more precise but requires a join.
      if (lastDelivery === null || r.created_at > lastDelivery) {
        lastDelivery = r.created_at;
      }
    }
  }
  return {
    ...p,
    cost_today_usd: costToday,
    cost_mtd_usd: costMtd,
    in_flight_runs: inFlight,
    last_delivery_ts: lastDelivery,
  };
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonthMs(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function countFindings(
  findings: { critic: CriticName; severity: Severity }[],
): Record<Severity, number> & { total: number } {
  const counts: Record<Severity, number> = {
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
    CRITICAL: 0,
  };
  for (const f of findings) {
    counts[f.severity] += 1;
  }
  return { ...counts, total: findings.length };
}

function filterLedgerByProject(
  store: StateStore,
  entries: LedgerEntry[],
  projectId: string,
): LedgerEntry[] {
  // Get the set of run ids that belong to this project, then keep ledger
  // entries that have at least one matching finding fingerprint among
  // those runs. LedgerEntry has no run_id, so we walk the per-run
  // findings — fine for Phase 1 volumes.
  const projectRuns = store
    .listRuns({ projectId, limit: 10_000 })
    .map((r: RunRow) => r.id);
  const fingerprintsInProject = new Set<string>();
  for (const runId of projectRuns) {
    for (const f of store.listFindings(runId)) {
      fingerprintsInProject.add(f.fingerprint);
    }
  }
  return entries.filter((e) => fingerprintsInProject.has(e.fingerprint));
}

function parseMode(raw: string | null): RunMode | "invalid" {
  if (!raw) return "new";
  const v = raw.trim().toLowerCase();
  if (v === "new" || v === "edit") return v;
  return "invalid";
}

function parseAnswers(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const raw = b.answers;
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const item of raw) {
      if (!item || typeof item !== "object") return null;
      const it = item as Record<string, unknown>;
      const id = typeof it.question_id === "string" ? it.question_id : null;
      const ans = typeof it.answer === "string" ? it.answer : null;
      if (!id || ans === null) return null;
      out[id] = ans;
    }
    return out;
  }
  if (typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== "string") return null;
      out[k] = v;
    }
    return out;
  }
  return null;
}

async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function numField(body: Record<string, unknown>, key: string): number | null {
  const v = body[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function intField(body: Record<string, unknown>, key: string): number | null {
  const v = body[key];
  if (typeof v === "number" && Number.isInteger(v)) return v;
  return null;
}

function boolField(body: Record<string, unknown>, key: string): boolean {
  const v = body[key];
  return v === true || v === "true" || v === 1;
}
