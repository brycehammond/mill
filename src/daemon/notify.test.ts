import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import { SqliteStateStore } from "../core/store.sqlite.js";
import type { EventRow } from "../core/index.js";
import {
  mapBusKindToWireEvent,
  signBody,
  startNotifyWorker,
  SUPPORTED_WEBHOOK_EVENTS,
} from "./notify.js";

// Light fixture: in-memory SQLite, one project, one run, one webhook.
// Tests inject a fake fetch + wait so backoff timing doesn't sit on
// real timers, and assert against the recorded HTTP traffic.

interface RecordedRequest {
  url: string;
  method: string;
  body: string;
  signature: string;
  abortedBefore: boolean;
}

interface FetchHandler {
  (req: RecordedRequest): Promise<{ status: number }> | { status: number };
}

function makeFakeFetch(handler: FetchHandler): {
  fetchImpl: typeof globalThis.fetch;
  recorded: RecordedRequest[];
} {
  const recorded: RecordedRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const sig = headers["x-mill-signature"] ?? "";
    const body = typeof init?.body === "string" ? init.body : "";
    const signal = init?.signal ?? null;
    const abortedBefore = signal ? signal.aborted : false;
    const rec: RecordedRequest = {
      url,
      method,
      body,
      signature: sig,
      abortedBefore,
    };
    recorded.push(rec);
    const result = await handler(rec);
    return new Response(null, { status: result.status });
  };
  return { fetchImpl, recorded };
}

function freshStore(): SqliteStateStore {
  const s = new SqliteStateStore(":memory:");
  s.init();
  return s;
}

function setup() {
  const store = freshStore();
  store.addProject({
    id: "p1-aaaa",
    name: "test-project",
    root_path: "/tmp/p1",
  });
  store.createRun({
    id: "r1",
    project_id: "p1-aaaa",
    status: "running",
    kind: "cli",
    created_at: 1_700_000_000_000,
    requirement_path: "/tmp/r1.md",
  });
  return store;
}

function makeEventRow(
  kind: string,
  payload: unknown = {},
  runId = "r1",
): EventRow {
  return {
    id: 1,
    run_id: runId,
    stage: "deliver",
    ts: Date.now(),
    kind,
    actor: "mill",
    payload_json: JSON.stringify(payload),
  };
}

describe("notify worker", () => {
  it("HMAC-SHA256 signs the body using the webhook secret", () => {
    // Independent oracle: sign the same body with a known secret using
    // node:crypto and confirm signBody matches. Catches accidental hex
    // encoding / digest length drift.
    const body = '{"event":"run.completed","run_id":"r1"}';
    const secret = "topsecret";
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    assert.equal(signBody(body, secret), expected);
  });

  it("delivers a payload with the right shape and signature on first try", async () => {
    const store = setup();
    store.createWebhook({
      id: "w1",
      project_id: "p1-aaaa",
      url: "http://hooks.example/incoming",
      event_filter: "run.completed",
      secret: "s3cret",
    });
    const { fetchImpl, recorded } = makeFakeFetch(() => ({ status: 200 }));
    const worker = startNotifyWorker({
      store,
      publicUrl: "https://mill.example/",
      fetchImpl,
      wait: () => Promise.resolve(),
      logger: () => {},
    });
    try {
      const matched = worker.enqueueEvent(
        makeEventRow("run_completed", {
          summary: "delivered cleanly",
        }),
      );
      assert.equal(matched, 1);
      await worker.whenIdle();
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]!.url, "http://hooks.example/incoming");
      assert.equal(recorded[0]!.method, "POST");
      const payload = JSON.parse(recorded[0]!.body) as Record<string, unknown>;
      assert.equal(payload.event, "run.completed");
      assert.equal(payload.run_id, "r1");
      assert.equal(payload.project_id, "p1-aaaa");
      assert.equal(payload.project_name, "test-project");
      assert.equal(payload.summary, "delivered cleanly");
      assert.equal(payload.url, "https://mill.example/runs/r1");
      // Signature header matches the body + secret.
      const expected = signBody(recorded[0]!.body, "s3cret");
      assert.equal(recorded[0]!.signature, `sha256=${expected}`);
      // Success resets consecutive_failures (already 0 here, but the
      // call must not raise).
      const w = store.getWebhook("w1");
      assert.equal(w?.consecutive_failures, 0);
    } finally {
      worker.stop();
      store.close();
    }
  });

  it("omits payload.url when MILL_PUBLIC_URL is unset", async () => {
    const store = setup();
    store.createWebhook({
      id: "w1",
      project_id: "p1-aaaa",
      url: "http://hooks.example/x",
      event_filter: "run.completed",
      secret: "s",
    });
    const { fetchImpl, recorded } = makeFakeFetch(() => ({ status: 200 }));
    const worker = startNotifyWorker({
      store,
      publicUrl: undefined,
      fetchImpl,
      wait: () => Promise.resolve(),
      logger: () => {},
    });
    try {
      worker.enqueueEvent(makeEventRow("run_completed"));
      await worker.whenIdle();
      const payload = JSON.parse(recorded[0]!.body) as Record<string, unknown>;
      assert.ok(!("url" in payload), "payload.url should be omitted");
    } finally {
      worker.stop();
      store.close();
    }
  });

  it("retries 3x on 500 with backoff, then drops; 4th call is NOT made", async () => {
    const store = setup();
    store.createWebhook({
      id: "w1",
      project_id: "p1-aaaa",
      url: "http://hooks.example/fail",
      event_filter: "run.completed",
      secret: "s",
    });
    const waits: number[] = [];
    const { fetchImpl, recorded } = makeFakeFetch(() => ({ status: 500 }));
    const worker = startNotifyWorker({
      store,
      fetchImpl,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      logger: () => {},
    });
    try {
      worker.enqueueEvent(makeEventRow("run_completed"));
      await worker.whenIdle();
      // 1 initial attempt + 3 retries = 4 total calls. The fifth call
      // must not happen.
      assert.equal(recorded.length, 4, "expected initial + 3 retries");
      assert.deepEqual(waits, [1_000, 5_000, 30_000]);
      // Terminal failure increments consecutive_failures by exactly 1.
      const w = store.getWebhook("w1");
      assert.equal(w?.consecutive_failures, 1);
      // Webhook stays enabled until threshold (10).
      assert.equal(w?.enabled, true);
    } finally {
      worker.stop();
      store.close();
    }
  });

  it("auto-disables a webhook after 10 consecutive terminal failures", async () => {
    const store = setup();
    store.createWebhook({
      id: "w1",
      project_id: "p1-aaaa",
      url: "http://hooks.example/perpetual-500",
      event_filter: "run.completed",
      secret: "s",
    });
    const { fetchImpl } = makeFakeFetch(() => ({ status: 500 }));
    const worker = startNotifyWorker({
      store,
      fetchImpl,
      wait: () => Promise.resolve(),
      logger: () => {},
    });
    try {
      // Each enqueueEvent call ends in one terminal failure, so 10
      // calls should auto-disable on the 10th.
      for (let i = 0; i < 10; i++) {
        worker.enqueueEvent(makeEventRow("run_completed"));
        await worker.whenIdle();
      }
      const w = store.getWebhook("w1");
      assert.equal(w?.consecutive_failures, 10);
      assert.equal(w?.enabled, false);
    } finally {
      worker.stop();
      store.close();
    }
  });

  it("aborts a slow request via 5s timeout and treats it as a failure", async () => {
    const store = setup();
    store.createWebhook({
      id: "w1",
      project_id: "p1-aaaa",
      url: "http://hooks.example/slow",
      event_filter: "run.completed",
      secret: "s",
    });
    let abortObserved = false;
    // The fake fetch resolves only when its AbortSignal aborts. The
    // worker's 5s timer will fire (Node's real setTimeout) and the
    // fetchImpl's signal listener resolves with a thrown AbortError —
    // which the worker treats as a failure.
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected abort signal");
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          abortObserved = true;
          const err = new Error("aborted") as Error & { name: string };
          err.name = "AbortError";
          reject(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    };
    const worker = startNotifyWorker({
      store,
      fetchImpl,
      // Skip backoff so we don't wait through three real retries.
      wait: () => Promise.resolve(),
      // Short request timeout so the test runs fast — the production
      // value is 5s but the abort-path is what we're verifying.
      requestTimeoutMs: 25,
      logger: () => {},
    });
    try {
      worker.enqueueEvent(makeEventRow("run_completed"));
      await worker.whenIdle();
      // Each attempt triggered the timeout abort; after retries the
      // job is dropped. We just need to confirm the abort fired at
      // least once and the webhook count moved.
      assert.ok(abortObserved, "AbortController.abort() should have fired");
      const w = store.getWebhook("w1");
      assert.ok(w);
      assert.equal(w.consecutive_failures, 1);
    } finally {
      worker.stop();
      store.close();
    }
  });

  it("does not deliver events that don't match any webhook's filter", async () => {
    const store = setup();
    // Subscribed only to run.completed — finding.high should NOT fire.
    store.createWebhook({
      id: "w1",
      project_id: "p1-aaaa",
      url: "http://hooks.example/run-only",
      event_filter: "run.completed",
      secret: "s",
    });
    const { fetchImpl, recorded } = makeFakeFetch(() => ({ status: 200 }));
    const worker = startNotifyWorker({
      store,
      fetchImpl,
      wait: () => Promise.resolve(),
      logger: () => {},
    });
    try {
      const matchedHigh = worker.enqueueEvent(
        makeEventRow("finding_high", { title: "x" }),
      );
      assert.equal(matchedHigh, 0);
      const matchedCompleted = worker.enqueueEvent(makeEventRow("run_completed"));
      assert.equal(matchedCompleted, 1);
      await worker.whenIdle();
      assert.equal(recorded.length, 1);
      const payload = JSON.parse(recorded[0]!.body) as { event: string };
      assert.equal(payload.event, "run.completed");
    } finally {
      worker.stop();
      store.close();
    }
  });

  it("ignores disabled webhooks", async () => {
    const store = setup();
    store.createWebhook({
      id: "w1",
      project_id: "p1-aaaa",
      url: "http://hooks.example/disabled",
      event_filter: "run.completed",
      secret: "s",
    });
    store.disableWebhook("w1");
    const { fetchImpl, recorded } = makeFakeFetch(() => ({ status: 200 }));
    const worker = startNotifyWorker({
      store,
      fetchImpl,
      wait: () => Promise.resolve(),
      logger: () => {},
    });
    try {
      const matched = worker.enqueueEvent(makeEventRow("run_completed"));
      assert.equal(matched, 0);
      await worker.whenIdle();
      assert.equal(recorded.length, 0);
    } finally {
      worker.stop();
      store.close();
    }
  });

  it("resetWebhookFailures runs after a successful retry", async () => {
    const store = setup();
    store.createWebhook({
      id: "w1",
      project_id: "p1-aaaa",
      url: "http://hooks.example/flaky",
      event_filter: "run.completed",
      secret: "s",
    });
    // Pre-bump the failure counter so we can observe the reset.
    store.incWebhookFailures("w1");
    store.incWebhookFailures("w1");
    assert.equal(store.getWebhook("w1")!.consecutive_failures, 2);

    let calls = 0;
    const { fetchImpl } = makeFakeFetch(() => {
      calls += 1;
      // Fail the first attempt, succeed on the retry.
      return { status: calls === 1 ? 500 : 200 };
    });
    const worker = startNotifyWorker({
      store,
      fetchImpl,
      wait: () => Promise.resolve(),
      logger: () => {},
    });
    try {
      worker.enqueueEvent(makeEventRow("run_completed"));
      await worker.whenIdle();
      assert.equal(store.getWebhook("w1")!.consecutive_failures, 0);
    } finally {
      worker.stop();
      store.close();
    }
  });

  it("maps every supported wire event to a known bus kind", () => {
    // SUPPORTED_WEBHOOK_EVENTS is the validated set the server uses
    // for /webhooks creation. Every entry must be reachable from at
    // least one bus kind via mapBusKindToWireEvent.
    const reachable = new Set<string>();
    for (const k of [
      "run_completed",
      "run_failed",
      "run_killed",
      "finding_high",
      "approval_required",
      "budget_warning_80",
      "budget_exceeded",
    ]) {
      const wire = mapBusKindToWireEvent(k);
      if (wire) reachable.add(wire);
    }
    for (const ev of SUPPORTED_WEBHOOK_EVENTS) {
      assert.ok(
        reachable.has(ev),
        `${ev} is in SUPPORTED_WEBHOOK_EVENTS but not reachable from any bus kind`,
      );
    }
  });
});
