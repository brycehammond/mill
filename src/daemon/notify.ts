import { createHmac, randomUUID } from "node:crypto";
import {
  subscribeToAllEvents,
  type EventRow,
  type StateStore,
} from "../core/index.js";

// Outbound webhook delivery worker. Subscribes to the global event bus
// on startup and fans out matching events to per-project webhook
// subscriptions. Best-effort by design (architectural decision 7 in the
// Phase 3 plan): in-process queue, no durability, three retries with
// backoff (1s/5s/30s), then drop.
//
// Phase 3 supported event names — note the dot-notation on the wire
// vs. the snake_case the bus uses for the same kind. The mapping is
// the only place these names are translated; changing the canonical
// snake_case in core/types.ts requires updating SUPPORTED_EVENTS too.
//
//   bus kind (snake_case)   →   webhook event (dot-notation)
//   --------------------------------------------------------
//   run_completed           →   run.completed
//   run_failed              →   run.failed
//   run_killed              →   run.killed
//   finding_high            →   finding.high
//   approval_required       →   approval.required
//   budget_warning_80       →   budget.warning_80
//   budget_exceeded         →   budget.exceeded

const KIND_TO_WIRE: Record<string, string> = {
  run_completed: "run.completed",
  run_failed: "run.failed",
  run_killed: "run.killed",
  finding_high: "finding.high",
  approval_required: "approval.required",
  budget_warning_80: "budget.warning_80",
  budget_exceeded: "budget.exceeded",
};

export const SUPPORTED_WEBHOOK_EVENTS: ReadonlySet<string> = new Set(
  Object.values(KIND_TO_WIRE),
);

export function mapBusKindToWireEvent(kind: string): string | null {
  return KIND_TO_WIRE[kind] ?? null;
}

export interface NotifyJob {
  id: string;
  webhookId: string;
  url: string;
  secret: string;
  body: string;
  attempt: number;
}

export interface NotifyDeps {
  store: StateStore;
  // Absolute UI URL (`MILL_PUBLIC_URL`). When unset the payload's `url`
  // field is omitted entirely.
  publicUrl?: string | undefined;
  // Injectable HTTP transport for tests. Defaults to globalThis.fetch.
  fetchImpl?: typeof globalThis.fetch;
  // Injectable wait function for tests so backoff timing doesn't sit
  // on real timers. Returns a promise that resolves after `ms` ms.
  // Default uses setTimeout.
  wait?: (ms: number) => Promise<void>;
  // Injectable now() for deterministic test payload timestamps. Used
  // for the `ts` field in the payload only — DB timestamps come from
  // appendEvent.
  now?: () => number;
  // Logger callback. Defaults to writing to stderr (or no-op in tests).
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
  // Override the per-request timeout. Tests use a small value so the
  // abort-path test doesn't sit on a real 5s timer four times in a
  // row. Production uses 5s per Phase 3 plan.
  requestTimeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 5_000;
const BACKOFF_SCHEDULE_MS = [1_000, 5_000, 30_000] as const;
const AUTO_DISABLE_THRESHOLD = 10;

export interface NotifyHandle {
  // Stop the worker: detach from the bus and stop processing the queue.
  stop(): void;
  // Snapshot of pending jobs (for tests / debugging).
  pending(): number;
  // For tests: enqueue an event-row directly without the bus, equivalent
  // to what the bus subscriber does. Returns the number of webhooks
  // matched.
  enqueueEvent(row: EventRow): number;
  // For tests: drain the queue. Resolves when no jobs remain (succeeded,
  // dropped, or auto-disabled).
  whenIdle(): Promise<void>;
}

export function startNotifyWorker(deps: NotifyDeps): NotifyHandle {
  const {
    store,
    publicUrl,
    fetchImpl = globalThis.fetch.bind(globalThis),
    wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    logger = (msg, meta) => {
      const tail = meta ? ` ${JSON.stringify(meta)}` : "";
      process.stderr.write(`notify: ${msg}${tail}\n`);
    },
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
  } = deps;

  const queue: NotifyJob[] = [];
  let running = false;
  let stopped = false;
  let idleResolvers: Array<() => void> = [];

  const notifyIdle = (): void => {
    if (queue.length > 0 || running) return;
    const r = idleResolvers;
    idleResolvers = [];
    for (const fn of r) fn();
  };

  function enqueueEvent(row: EventRow): number {
    const wire = mapBusKindToWireEvent(row.kind);
    if (!wire) return 0;
    const project = lookupProject(store, row.run_id);
    if (!project) return 0;
    const webhooks = store.listWebhooksByEvent(project.id, wire);
    if (webhooks.length === 0) return 0;

    const summary = buildSummary(row);
    const payload: Record<string, unknown> = {
      event: wire,
      ts: new Date(now()).toISOString(),
      run_id: row.run_id,
      project_id: project.id,
      project_name: project.name,
      summary,
    };
    if (publicUrl) {
      payload.url = `${stripTrailingSlash(publicUrl)}/runs/${row.run_id}`;
    }
    const body = JSON.stringify(payload);

    for (const w of webhooks) {
      queue.push({
        id: randomUUID(),
        webhookId: w.id,
        url: w.url,
        secret: w.secret,
        body,
        attempt: 0,
      });
    }
    void pump();
    return webhooks.length;
  }

  async function pump(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      while (queue.length > 0 && !stopped) {
        const job = queue.shift()!;
        await deliver(job);
      }
    } finally {
      running = false;
      notifyIdle();
    }
  }

  async function deliver(job: NotifyJob): Promise<void> {
    const ok = await tryDeliver(job);
    if (ok) {
      try {
        store.resetWebhookFailures(job.webhookId);
      } catch (err) {
        logger("resetWebhookFailures failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    // Network/non-2xx failure. Schedule the next attempt with backoff,
    // or give up after the third retry. consecutive_failures is bumped
    // on each terminal failure (final attempt) — not on every retry —
    // so an intermittent webhook that recovers on attempt 2 doesn't
    // creep toward auto-disable.
    if (job.attempt + 1 < BACKOFF_SCHEDULE_MS.length + 1) {
      const delay = BACKOFF_SCHEDULE_MS[job.attempt]!;
      job.attempt += 1;
      await wait(delay);
      if (stopped) return;
      const finalOk = await tryDeliver(job);
      if (finalOk) {
        try {
          store.resetWebhookFailures(job.webhookId);
        } catch (err) {
          logger("resetWebhookFailures failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      // recurse-by-loop until attempts exhausted
      while (job.attempt < BACKOFF_SCHEDULE_MS.length) {
        const d = BACKOFF_SCHEDULE_MS[job.attempt]!;
        job.attempt += 1;
        await wait(d);
        if (stopped) return;
        if (await tryDeliver(job)) {
          try {
            store.resetWebhookFailures(job.webhookId);
          } catch (err) {
            logger("resetWebhookFailures failed", {
              err: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }
      }
    }
    // All attempts exhausted — terminal failure. Bump the consecutive
    // failure count and auto-disable if it crosses threshold.
    let count = 0;
    try {
      count = store.incWebhookFailures(job.webhookId);
    } catch (err) {
      logger("incWebhookFailures failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    logger("webhook delivery dropped after retries", {
      webhookId: job.webhookId,
      url: job.url,
      consecutive_failures: count,
    });
    if (count >= AUTO_DISABLE_THRESHOLD) {
      try {
        store.disableWebhook(job.webhookId);
        // Direct appendEvent — recursing into the queue would risk a
        // delivery loop and is also pointless (a webhook subscribed to
        // its own disable event would just get re-disabled).
        const w = store.getWebhook(job.webhookId);
        if (w) {
          // Stage 'deliver' is a stable existing StageName; the event
          // is informational and not tied to a pipeline stage.
          store.appendEvent(
            firstRunIdForWebhookEvent(job),
            "deliver",
            "webhook_disabled",
            {
              webhook_id: w.id,
              project_id: w.project_id,
              url: w.url,
              consecutive_failures: count,
            },
          );
        }
      } catch (err) {
        logger("auto-disable failed", {
          err: err instanceof Error ? err.message : String(err),
          webhookId: job.webhookId,
        });
      }
    }
  }

  async function tryDeliver(job: NotifyJob): Promise<boolean> {
    const sig = signBody(job.body, job.secret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const res = await fetchImpl(job.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mill-signature": `sha256=${sig}`,
        },
        body: job.body,
        signal: controller.signal,
      });
      // 2xx is success; everything else (3xx redirects included) is a
      // failure for our purposes — we don't follow redirects to keep
      // the subprocess simple and predictable.
      return res.ok;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger("webhook attempt failed", {
        webhookId: job.webhookId,
        url: job.url,
        attempt: job.attempt,
        err: msg,
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // Bind to the bus. `subscribeToAllEvents` returns the unsubscribe fn
  // we call from stop().
  const unsub = subscribeToAllEvents((row) => {
    if (stopped) return;
    try {
      enqueueEvent(row);
    } catch (err) {
      logger("enqueueEvent threw", {
        err: err instanceof Error ? err.message : String(err),
        kind: row.kind,
      });
    }
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsub();
      // Resolve any in-flight whenIdle waiters so callers don't block
      // shutdown. The queue may still have pending jobs that won't be
      // delivered — that's the cost of a non-durable best-effort design.
      const r = idleResolvers;
      idleResolvers = [];
      for (const fn of r) fn();
    },
    pending: () => queue.length,
    enqueueEvent: (row) => enqueueEvent(row),
    whenIdle: () =>
      new Promise<void>((resolve) => {
        if (queue.length === 0 && !running) {
          resolve();
          return;
        }
        idleResolvers.push(resolve);
      }),
  };
}

// HMAC-SHA256(body, secret) hex-encoded. Header form is
// `X-Mill-Signature: sha256=<hex>`. Exported for tests so they can
// independently compute the expected signature.
export function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function lookupProject(
  store: StateStore,
  runId: string,
): { id: string; name: string } | null {
  const run = store.getRun(runId);
  if (!run || !run.project_id) return null;
  const project = store.getProject(run.project_id);
  if (!project) return null;
  return { id: project.id, name: project.name };
}

function buildSummary(row: EventRow): string {
  // Best-effort short description of the event for human consumption
  // in chat / Slack. Falls back to the kind itself when the payload
  // doesn't carry anything obvious.
  let payload: unknown = null;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    payload = null;
  }
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.summary === "string" && p.summary.trim()) return p.summary.trim();
    if (typeof p.title === "string" && p.title.trim()) return p.title.trim();
    if (typeof p.message === "string" && p.message.trim()) return p.message.trim();
    if (typeof p.reason === "string" && p.reason.trim()) return p.reason.trim();
  }
  return row.kind;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function firstRunIdForWebhookEvent(job: NotifyJob): string {
  // The webhook_disabled event needs a run id to satisfy the events
  // table FK, but auto-disable isn't tied to a specific run — it's
  // about the webhook's own health. We parse it out of the body of
  // the failing job (which includes run_id) so the audit trail at
  // least points at the run that triggered the final failure.
  try {
    const parsed = JSON.parse(job.body) as { run_id?: unknown };
    if (typeof parsed.run_id === "string") return parsed.run_id;
  } catch {
    // ignore
  }
  return "unknown";
}
