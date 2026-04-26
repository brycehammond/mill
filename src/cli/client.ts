// Thin HTTP client used by mutating CLI commands to talk to the local
// `mill daemon`. The daemon owns SQLite writes and pipeline execution;
// the CLI is reduced to formatting input and rendering output. Reads are
// allowed to bypass the daemon (see `cli.ts` for the read paths) so
// `mill status` / `mill findings` keep working when the daemon is down.
//
// Transport is plain JSON over HTTP on loopback. No auth (Phase 1).
// Field names follow the daemon's snake_case convention so the body is
// passed through without translation. Some routes wrap their result
// (`{entries: [...]}`) and some return the value directly — see each
// method for the exact shape.
//
// On any connection error (the daemon process isn't running) we throw a
// typed `DaemonNotRunningError` whose message tells the user how to
// start it. CLI surface translates that to a clean stderr line.

import { loadGlobalConfig, type GlobalMillConfig } from "../orchestrator/index.js";
import type {
  Clarifications,
  DisplayStageRow,
  EventRow,
  LedgerEntry,
  ProjectRow,
  RunMode,
  RunRow,
  Severity,
  RunStatus,
} from "../core/index.js";

export class DaemonNotRunningError extends Error {
  constructor() {
    super("daemon not running. Start it with: mill daemon start");
    this.name = "DaemonNotRunningError";
  }
}

// Project row enriched with cost rollups and in-flight count, returned
// from `GET /projects` and `GET /projects/:id`. Field names match the
// daemon's response shape verbatim.
export interface EnrichedProject extends ProjectRow {
  cost_today_usd: number;
  cost_mtd_usd: number;
  in_flight_runs: number;
  last_delivery_ts: number | null;
}

export interface DaemonHealth {
  ok: boolean;
  pid: number;
  uptime_s: number;
  port: number;
  host: string;
}

// Used by `POST /projects/:id/runs`. The daemon kicks off the same intake
// flow that `mill new` used to drive in-process; the response surfaces
// the new run id and the clarification questions the user must answer
// next (or `clarifications: null` when `all_defaults` was set).
export interface CreateRunBody {
  requirement: string;
  mode?: RunMode;
  stop_after?: "spec" | "design" | "spec2tests";
  all_defaults?: boolean;
}

export interface CreateRunResponse {
  run_id: string;
  mode: RunMode;
  branch: string | null;
  base_branch: string | null;
  status: RunStatus;
  clarifications: Clarifications | null;
}

export interface CreateProjectBody {
  root_path: string;
  name?: string;
  monthly_budget_usd?: number | null;
  default_concurrency?: number | null;
}

export interface CreateProjectResponse {
  project: ProjectRow;
  // false on a second registration of the same path. Mirrors `addProject`
  // which is idempotent.
  created: boolean;
  // Set by the legacy migration path on first registration. The daemon
  // route surfaces row counts so the CLI can print "imported N runs".
  // Not populated yet (the migration teammate is wiring this up); all
  // CLI sites treat it as optional.
  migration?: {
    runs_imported: number;
    events_imported: number;
    findings_imported: number;
    legacy_db_renamed_to: string | null;
  };
}

export interface FindingsCounts {
  LOW: number;
  MEDIUM: number;
  HIGH: number;
  CRITICAL: number;
  total: number;
}

export interface RunDetail {
  run: RunRow;
  stages: DisplayStageRow[];
  findings_counts: FindingsCounts;
}

export interface ListRunsFilters {
  projectId?: string;
  status?: RunStatus;
  limit?: number;
}

export interface FindingsFilters {
  projectId?: string;
  limit?: number;
  minRuns?: number;
  includeSuppressed?: boolean;
}

// Allow tests to inject a fetch implementation (a tiny in-process
// server, or a stub). `globalThis.fetch` is the default — Node 22 ships
// it natively, no node-fetch dep needed.
export interface DaemonClientOptions {
  config?: GlobalMillConfig;
  fetchImpl?: typeof globalThis.fetch;
}

export class DaemonClient {
  private readonly base: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(opts: DaemonClientOptions = {}) {
    const config = opts.config ?? loadGlobalConfig();
    this.base = `http://${config.daemonHost}:${config.daemonPort}`;
    this.doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // ----- liveness -----

  async healthz(): Promise<DaemonHealth> {
    return this.request<DaemonHealth>("GET", "/healthz");
  }

  async isLive(): Promise<boolean> {
    try {
      await this.healthz();
      return true;
    } catch (err) {
      if (err instanceof DaemonNotRunningError) return false;
      throw err;
    }
  }

  // ----- projects -----

  async createProject(body: CreateProjectBody): Promise<CreateProjectResponse> {
    return this.request<CreateProjectResponse>("POST", "/projects", body);
  }

  async listProjects(opts: { includeRemoved?: boolean } = {}): Promise<EnrichedProject[]> {
    const qs = buildQuery({ include_removed: opts.includeRemoved ? "1" : undefined });
    return this.request<EnrichedProject[]>("GET", `/projects${qs}`);
  }

  async getProject(id: string): Promise<EnrichedProject> {
    return this.request<EnrichedProject>(
      "GET",
      `/projects/${encodeURIComponent(id)}`,
    );
  }

  async deleteProject(
    id: string,
  ): Promise<{ project: ProjectRow | null; removed: boolean }> {
    return this.request<{ project: ProjectRow | null; removed: boolean }>(
      "DELETE",
      `/projects/${encodeURIComponent(id)}`,
    );
  }

  // ----- runs -----

  async createRun(
    projectId: string,
    body: CreateRunBody,
  ): Promise<CreateRunResponse> {
    return this.request<CreateRunResponse>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/runs`,
      body,
    );
  }

  async submitClarifications(
    runId: string,
    answers: Record<string, string>,
  ): Promise<{ run_id: string; status: RunStatus }> {
    return this.request<{ run_id: string; status: RunStatus }>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/clarifications`,
      { answers },
    );
  }

  async resumeRun(runId: string): Promise<{ run_id: string; status: RunStatus }> {
    return this.request<{ run_id: string; status: RunStatus }>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/resume`,
    );
  }

  async killRun(
    runId: string,
  ): Promise<{ run_id: string; killed_path: string; status: RunStatus }> {
    return this.request<{ run_id: string; killed_path: string; status: RunStatus }>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/kill`,
    );
  }

  async listRuns(filters: ListRunsFilters = {}): Promise<RunRow[]> {
    const qs = buildQuery({
      project: filters.projectId,
      status: filters.status,
      limit: filters.limit,
    });
    return this.request<RunRow[]>("GET", `/runs${qs}`);
  }

  async getRun(runId: string): Promise<RunDetail> {
    return this.request<RunDetail>(
      "GET",
      `/runs/${encodeURIComponent(runId)}`,
    );
  }

  async getRunEvents(
    runId: string,
    sinceId = 0,
    limit?: number,
  ): Promise<EventRow[]> {
    const qs = buildQuery({ since: sinceId || undefined, limit });
    const wrapped = await this.request<{ events: EventRow[] }>(
      "GET",
      `/runs/${encodeURIComponent(runId)}/events${qs}`,
    );
    return wrapped.events;
  }

  // ----- findings -----

  async getFindings(filters: FindingsFilters = {}): Promise<LedgerEntry[]> {
    const qs = buildQuery({
      project: filters.projectId,
      limit: filters.limit,
      min_runs: filters.minRuns,
      include_suppressed: filters.includeSuppressed ? "1" : undefined,
    });
    const wrapped = await this.request<{ entries: LedgerEntry[] }>(
      "GET",
      `/findings${qs}`,
    );
    return wrapped.entries;
  }

  // ----- internals -----

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw translateNetworkError(err);
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const msg =
        isObject(parsed) && typeof parsed["error"] === "string"
          ? (parsed["error"] as string)
          : `daemon ${method} ${path} failed: ${res.status}`;
      throw new Error(msg);
    }
    return parsed as T;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// `globalThis.fetch` (undici under the hood) collapses every connection
// failure into a generic TypeError("fetch failed") and stuffs the
// real cause on `.cause`. Walk that chain looking for ECONNREFUSED /
// ENOTFOUND / ECONNRESET — those mean "no daemon listening" rather than
// "daemon returned an error", and we want a different surface.
function translateNetworkError(err: unknown): Error {
  if (looksLikeConnRefused(err)) return new DaemonNotRunningError();
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function looksLikeConnRefused(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (isObject(cur)) {
      const code = cur["code"];
      if (
        code === "ECONNREFUSED" ||
        code === "ENOTFOUND" ||
        code === "ECONNRESET" ||
        code === "EAI_AGAIN"
      ) {
        return true;
      }
      cur = (cur as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

function buildQuery(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

// Re-exported severity union so CLI render code can compute counts in
// the same shape the daemon emits without re-importing core. Pure type.
export type { Severity };
