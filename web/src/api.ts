import type {
  Clarifications,
  CreateRunResponse,
  Dashboard,
  LedgerEntry,
  Project,
  Run,
  RunDetail,
  SuppressedEntry,
} from "./types.js";

// Typed client over the daemon's HTTP surface. All requests are
// loopback in dev (proxied via Vite) or same-origin in production.
// Errors are thrown as `ApiError` so React Query's retry/error states
// distinguish 4xx from network failures.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
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
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, parsed);
  }
  return parsed as T;
}

export const api = {
  healthz: () => req<{ ok: boolean; pid: number; uptime_s: number }>("GET", "/healthz"),

  // Phase 1 surface (unprefixed):
  listProjects: () => req<Project[]>("GET", "/projects"),
  getProject: (id: string) => req<Project>("GET", `/projects/${encodeURIComponent(id)}`),
  removeProject: (id: string) =>
    req<{ project: Project; removed: boolean }>(
      "DELETE",
      `/projects/${encodeURIComponent(id)}`,
    ),
  createProject: (body: { root_path: string; name?: string }) =>
    req<{ project: Project; created: boolean }>("POST", "/projects", body),

  listRuns: (filters: {
    project?: string;
    status?: string;
    limit?: number;
  } = {}) => {
    const qs = new URLSearchParams();
    if (filters.project) qs.set("project", filters.project);
    if (filters.status) qs.set("status", filters.status);
    if (filters.limit) qs.set("limit", String(filters.limit));
    const suffix = qs.toString();
    return req<Run[]>("GET", suffix ? `/runs?${suffix}` : "/runs");
  },

  getRun: (id: string) => req<RunDetail>("GET", `/runs/${encodeURIComponent(id)}`),

  createRun: (
    projectId: string,
    body: { requirement: string; mode?: string; all_defaults?: boolean },
  ) =>
    req<CreateRunResponse>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/runs`,
      body,
    ),

  submitClarifications: (runId: string, answers: Record<string, string>) =>
    req<{ run_id: string; status: string }>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/clarifications`,
      { answers },
    ),

  killRun: (runId: string) =>
    req<{ run_id: string; killed_path: string; status: string }>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/kill`,
    ),

  // Phase 2 /api/v1 surface:
  dashboard: () => req<Dashboard>("GET", "/api/v1/dashboard"),

  projectFindings: (projectId: string) =>
    req<{ entries: LedgerEntry[] }>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/findings`,
    ),

  findings: (
    opts: { project?: string; min_runs?: number; include_suppressed?: boolean } = {},
  ) => {
    const qs = new URLSearchParams();
    if (opts.project) qs.set("project", opts.project);
    if (opts.min_runs) qs.set("min_runs", String(opts.min_runs));
    if (opts.include_suppressed) qs.set("include_suppressed", "1");
    const suffix = qs.toString();
    return req<{ entries: LedgerEntry[] }>(
      "GET",
      suffix ? `/findings?${suffix}` : "/findings",
    );
  },

  listSuppressed: () =>
    req<{ entries: SuppressedEntry[] }>("GET", "/api/v1/findings/suppressed"),

  suppress: (fingerprint: string, note?: string) =>
    req<{ fingerprint: string; suppressed: true }>(
      "POST",
      "/api/v1/findings/suppressed",
      note ? { fingerprint, note } : { fingerprint },
    ),

  unsuppress: (fingerprint: string) =>
    req<{ fingerprint: string; suppressed: false }>(
      "DELETE",
      `/api/v1/findings/suppressed/${encodeURIComponent(fingerprint)}`,
    ),
};

// Convenience helper used in non-Query mutation paths so callers don't
// have to remember to include this for clarification answers shaped as
// dictionaries vs arrays — the daemon accepts either.
export type ClarificationsForm = {
  questions: Clarifications["questions"];
  answers: Record<string, string>;
};
