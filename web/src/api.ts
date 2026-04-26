import type {
  Clarifications,
  CreateRunResponse,
  Dashboard,
  LedgerEntry,
  Project,
  ProjectGates,
  Run,
  RunDetail,
  SessionInfo,
  StageName,
  SuppressedEntry,
  WebhookRow,
} from "./types.js";

// Typed client over the daemon's HTTP surface. All requests are
// loopback in dev (proxied via Vite) or same-origin in production.
// Errors are thrown as `ApiError` so React Query's retry/error states
// distinguish 4xx from network failures.
//
// Phase 3: every fetch sends `credentials: 'include'` so the cookie
// session ridealong works. A 401 on any non-login route triggers a
// hard navigation to /login?next=<current>, the single source of
// truth for unauthenticated bounce-out. Login itself opts out of the
// redirect via `suppressAuthRedirect` so the form can show its own
// error message instead of looping.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

function loginRedirect(): void {
  if (typeof window === "undefined") return;
  const here = window.location.pathname + window.location.search;
  if (window.location.pathname === "/login") return;
  const next = encodeURIComponent(here);
  window.location.assign(`/login?next=${next}`);
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { suppressAuthRedirect?: boolean },
): Promise<T> {
  const init: RequestInit = { method, credentials: "include" };
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
  if (res.status === 401 && !opts?.suppressAuthRedirect) {
    loginRedirect();
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

  // Phase 3 — auth.
  // Login posts with auth-redirect suppressed so a wrong token returns a
  // surface-able 401 instead of bouncing the user back to /login forever.
  login: (token: string, actor: string) =>
    req<SessionInfo>(
      "POST",
      "/api/v1/auth/session",
      { token, actor },
      { suppressAuthRedirect: true },
    ),
  logout: () => req<void>("POST", "/api/v1/auth/session/delete"),

  // Phase 3 — approval flow.
  approveRun: (runId: string, note?: string) =>
    req<{ run: Run }>(
      "POST",
      `/api/v1/runs/${encodeURIComponent(runId)}/approve`,
      note ? { note } : {},
    ),
  rejectRun: (runId: string, note: string) =>
    req<{ run: Run }>(
      "POST",
      `/api/v1/runs/${encodeURIComponent(runId)}/reject`,
      { note },
    ),
  resumeRun: (runId: string) =>
    req<{ run: Run }>("POST", `/api/v1/runs/${encodeURIComponent(runId)}/resume`),

  // Phase 3 — gates.
  getProjectGates: (projectId: string) =>
    req<ProjectGates>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/gates`,
    ),
  setProjectGates: (projectId: string, stages: StageName[]) =>
    req<ProjectGates>(
      "PUT",
      `/api/v1/projects/${encodeURIComponent(projectId)}/gates`,
      { stages },
    ),
  clearProjectGates: (projectId: string) =>
    req<{ ok: true }>(
      "DELETE",
      `/api/v1/projects/${encodeURIComponent(projectId)}/gates`,
    ),

  // Phase 3 — webhooks.
  listProjectWebhooks: (projectId: string) =>
    req<{ webhooks: WebhookRow[] }>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/webhooks`,
    ),
  createProjectWebhook: (
    projectId: string,
    body: { url: string; events: string[]; secret: string },
  ) =>
    req<{ webhook: WebhookRow }>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/webhooks`,
      body,
    ),
  deleteWebhook: (webhookId: string) =>
    req<{ ok: true }>(
      "DELETE",
      `/api/v1/webhooks/${encodeURIComponent(webhookId)}`,
    ),
};

// Convenience helper used in non-Query mutation paths so callers don't
// have to remember to include this for clarification answers shaped as
// dictionaries vs arrays — the daemon accepts either.
export type ClarificationsForm = {
  questions: Clarifications["questions"];
  answers: Record<string, string>;
};
