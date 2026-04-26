import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { DaemonClient, DaemonNotRunningError } from "./client.js";
import type { GlobalMillConfig } from "../orchestrator/index.js";

interface Recorded {
  method: string;
  path: string;
  body: string;
}

function startServer(
  handler: (
    req: { method: string; path: string; body: string },
    res: { status: number; json: unknown },
  ) => void,
): Promise<{ server: Server; port: number; recorded: Recorded[] }> {
  return new Promise((resolve) => {
    const recorded: Recorded[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const rec: Recorded = {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          body,
        };
        recorded.push(rec);
        const out = { status: 200, json: undefined as unknown };
        try {
          handler(rec, out);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: (err as Error).message }));
          return;
        }
        res.statusCode = out.status;
        if (out.json !== undefined) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(out.json));
        } else {
          res.end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, recorded });
    });
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

function fakeConfig(port: number): GlobalMillConfig {
  return {
    millHome: "/tmp/mill-test-home",
    dbPath: "/tmp/mill-test-home/mill.db",
    daemonHost: "127.0.0.1",
    daemonPort: port,
    maxConcurrentRuns: 2,
    maxReviewIters: 3,
    timeoutSecPerRun: 100,
    timeoutSecPerStage: 100,
    timeoutSecPerStageOverrides: {},
    model: undefined,
    publicUrl: undefined,
  };
}

describe("DaemonClient", () => {
  it("calls /healthz and returns parsed body", async () => {
    const { server, port, recorded } = await startServer((req, out) => {
      if (req.path === "/healthz" && req.method === "GET") {
        out.json = {
          ok: true,
          pid: 42,
          uptime_s: 7,
          port: 7333,
          host: "127.0.0.1",
        };
      } else {
        out.status = 404;
        out.json = { error: "not found" };
      }
    });
    try {
      const client = new DaemonClient({ config: fakeConfig(port) });
      const h = await client.healthz();
      assert.equal(h.ok, true);
      assert.equal(h.pid, 42);
      assert.equal(h.uptime_s, 7);
      assert.equal(recorded[0]?.method, "GET");
      assert.equal(recorded[0]?.path, "/healthz");
    } finally {
      await stop(server);
    }
  });

  it("createProject POSTs JSON body and returns response", async () => {
    const { server, port, recorded } = await startServer((req, out) => {
      out.json = {
        project: {
          id: "demo-aaaa",
          name: "demo",
          root_path: "/tmp/demo",
          added_at: 1,
          removed_at: null,
          monthly_budget_usd: null,
          default_concurrency: null,
        },
        created: true,
      };
    });
    try {
      const client = new DaemonClient({ config: fakeConfig(port) });
      const out = await client.createProject({
        root_path: "/tmp/demo",
        name: "demo",
      });
      assert.equal(out.created, true);
      assert.equal(out.project.id, "demo-aaaa");
      assert.equal(recorded[0]?.method, "POST");
      assert.equal(recorded[0]?.path, "/projects");
      assert.deepEqual(JSON.parse(recorded[0]?.body ?? "{}"), {
        root_path: "/tmp/demo",
        name: "demo",
      });
    } finally {
      await stop(server);
    }
  });

  it("listRuns serializes filters into the query string", async () => {
    const { server, port, recorded } = await startServer((_req, out) => {
      out.json = [];
    });
    try {
      const client = new DaemonClient({ config: fakeConfig(port) });
      await client.listRuns({ projectId: "demo", status: "running", limit: 10 });
      const path = recorded[0]?.path ?? "";
      assert.ok(path.startsWith("/runs?"), `unexpected path: ${path}`);
      assert.ok(path.includes("project=demo"));
      assert.ok(path.includes("status=running"));
      assert.ok(path.includes("limit=10"));
    } finally {
      await stop(server);
    }
  });

  it("non-2xx with error body throws Error(message)", async () => {
    const { server, port } = await startServer((_req, out) => {
      out.status = 400;
      out.json = { error: "missing root_path" };
    });
    try {
      const client = new DaemonClient({ config: fakeConfig(port) });
      await assert.rejects(
        () => client.createProject({ root_path: "" }),
        /missing root_path/,
      );
    } finally {
      await stop(server);
    }
  });

  it("ECONNREFUSED maps to DaemonNotRunningError", async () => {
    // Bind a server, immediately close it, then try to reach it. The OS
    // will refuse the connection on a port that's no longer listening.
    const { server, port } = await startServer(() => {});
    await stop(server);

    const client = new DaemonClient({ config: fakeConfig(port) });
    await assert.rejects(
      () => client.healthz(),
      (err) => err instanceof DaemonNotRunningError,
    );
  });

  it("isLive returns false when daemon is not running, true when it is", async () => {
    const { server, port } = await startServer((_req, out) => {
      out.json = { ok: true, pid: 1, startedAt: 0 };
    });
    try {
      const live = new DaemonClient({ config: fakeConfig(port) });
      assert.equal(await live.isLive(), true);
    } finally {
      await stop(server);
    }
    // Stopped server: should return false (DaemonNotRunningError swallowed).
    const dead = new DaemonClient({ config: fakeConfig(port) });
    assert.equal(await dead.isLive(), false);
  });

  it("custom fetchImpl is used when provided", async () => {
    let called = 0;
    const fakeFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      called++;
      assert.equal(init?.method, "GET");
      return new Response(
        JSON.stringify({
          ok: true,
          pid: 99,
          uptime_s: 1,
          port: 7333,
          host: "127.0.0.1",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;
    const client = new DaemonClient({
      config: fakeConfig(7333),
      fetchImpl: fakeFetch,
    });
    const h = await client.healthz();
    assert.equal(h.pid, 99);
    assert.equal(called, 1);
  });
});
