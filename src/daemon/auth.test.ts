import { strict as assert } from "node:assert";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { SqliteStateStore } from "../core/store.sqlite.js";
import {
  AUTH_TOKEN_FILENAME,
  SESSION_COOKIE_NAME,
  buildAuthMiddleware,
  buildClearSessionCookie,
  buildSessionCookie,
  constantTimeEqual,
  generateAuthToken,
  generateSessionId,
  getActor,
  initAuthToken,
  isAuthEnabled,
  parseCookies,
  readAuthToken,
  resolveAuthToken,
  rotateAuthToken,
  sessionLifetimeMs,
} from "./auth.js";

// Each test allocates a tmpdir for MILL_HOME and an isolated env so
// nothing in process.env (real ~/.mill/auth.token, real MILL_AUTH_TOKEN)
// leaks through. The middleware tests build a Hono app + in-memory
// store and exercise routes via app.fetch — same pattern as
// server.test.ts.

async function makeTmpHome(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `mill-auth-${prefix}-`));
}

function isolatedEnv(home: string, token?: string): NodeJS.ProcessEnv {
  return {
    MILL_HOME: home,
    ...(token ? { MILL_AUTH_TOKEN: token } : {}),
  } as NodeJS.ProcessEnv;
}

function inMemStore(): SqliteStateStore {
  const s = new SqliteStateStore(":memory:");
  s.init();
  return s;
}

describe("constantTimeEqual", () => {
  it("returns true on identical strings", () => {
    assert.equal(constantTimeEqual("abc", "abc"), true);
    assert.equal(constantTimeEqual("a".repeat(64), "a".repeat(64)), true);
  });

  it("returns false on different strings of the same length", () => {
    assert.equal(constantTimeEqual("abc", "abd"), false);
  });

  it("returns false on length mismatch (without throwing)", () => {
    // The dummy compare path runs internally; failure here is "throws"
    // (length-mismatch hitting timingSafeEqual is what we are guarding).
    assert.equal(constantTimeEqual("a", "ab"), false);
    assert.equal(constantTimeEqual("", "x"), false);
    assert.equal(constantTimeEqual("longer-string", "short"), false);
  });
});

describe("generateAuthToken / generateSessionId", () => {
  it("emits a 64-char hex token", () => {
    const t = generateAuthToken();
    assert.match(t, /^[0-9a-f]{64}$/);
  });

  it("session ids are also 64 hex chars and distinct between calls", () => {
    const a = generateSessionId();
    const b = generateSessionId();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });
});

describe("parseCookies", () => {
  it("returns empty object for undefined / empty headers", () => {
    assert.deepEqual(parseCookies(null), {});
    assert.deepEqual(parseCookies(""), {});
    assert.deepEqual(parseCookies(undefined), {});
  });

  it("parses a single cookie", () => {
    assert.deepEqual(parseCookies("mill_session=abc"), { mill_session: "abc" });
  });

  it("parses multiple cookies separated by semicolons", () => {
    assert.deepEqual(
      parseCookies("a=1; b=2;c=3"),
      { a: "1", b: "2", c: "3" },
    );
  });

  it("trims whitespace around names and values", () => {
    assert.deepEqual(
      parseCookies("  mill_session = xyz ;  other=v "),
      { mill_session: "xyz", other: "v" },
    );
  });

  it("ignores entries without an `=` and entries with empty key", () => {
    assert.deepEqual(parseCookies("flag; =val; foo=bar"), { foo: "bar" });
  });
});

describe("buildSessionCookie / buildClearSessionCookie", () => {
  it("emits HttpOnly + SameSite=Strict + Path=/ + Max-Age + Secure by default", () => {
    const c = buildSessionCookie("sid123", { maxAgeMs: 60_000 });
    assert.ok(c.startsWith("mill_session=sid123;"));
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /Path=\//);
    assert.match(c, /Max-Age=60/);
    assert.match(c, /Secure/);
  });

  it("omits Secure when insecure: true (loopback / local dev)", () => {
    const c = buildSessionCookie("sid", { maxAgeMs: 30_000, insecure: true });
    assert.ok(!c.includes("Secure"));
    assert.match(c, /HttpOnly/);
  });

  it("clear-cookie has Max-Age=0 and empty value", () => {
    const c = buildClearSessionCookie({ insecure: false });
    assert.ok(c.startsWith("mill_session=;"));
    assert.match(c, /Max-Age=0/);
    assert.match(c, /Secure/);
    const insec = buildClearSessionCookie({ insecure: true });
    assert.ok(!insec.includes("Secure"));
  });
});

describe("sessionLifetimeMs", () => {
  it("defaults to 30 days", () => {
    const ms = sessionLifetimeMs({});
    assert.equal(ms, 30 * 24 * 60 * 60 * 1000);
  });

  it("respects MILL_SESSION_LIFETIME_DAYS", () => {
    const ms = sessionLifetimeMs({ MILL_SESSION_LIFETIME_DAYS: "7" });
    assert.equal(ms, 7 * 24 * 60 * 60 * 1000);
  });

  it("falls back to default on garbage values", () => {
    assert.equal(
      sessionLifetimeMs({ MILL_SESSION_LIFETIME_DAYS: "abc" }),
      30 * 24 * 60 * 60 * 1000,
    );
    assert.equal(
      sessionLifetimeMs({ MILL_SESSION_LIFETIME_DAYS: "0" }),
      30 * 24 * 60 * 60 * 1000,
    );
  });
});

describe("token file lifecycle (init / show / rotate)", () => {
  it("initAuthToken writes a hex token at mode 0600 once, refuses to clobber", async () => {
    const home = await makeTmpHome("init");
    const env = isolatedEnv(home);
    const r1 = await initAuthToken(env);
    assert.equal(r1.created, true);
    assert.match(r1.token, /^[0-9a-f]{64}$/);
    assert.equal(r1.path, join(home, AUTH_TOKEN_FILENAME));
    const onDisk = (await readFile(r1.path, "utf8")).trim();
    assert.equal(onDisk, r1.token);
    const st = await stat(r1.path);
    assert.equal(st.mode & 0o777, 0o600);

    // Second init returns existing token, doesn't overwrite.
    const r2 = await initAuthToken(env);
    assert.equal(r2.created, false);
    assert.equal(r2.token, r1.token);
  });

  it("rotateAuthToken replaces the on-disk token", async () => {
    const home = await makeTmpHome("rotate");
    const env = isolatedEnv(home);
    const r1 = await initAuthToken(env);
    const r2 = await rotateAuthToken(env);
    assert.notEqual(r2.token, r1.token);
    const onDisk = (await readFile(r2.path, "utf8")).trim();
    assert.equal(onDisk, r2.token);
  });

  it("readAuthToken returns null when the file is missing, value otherwise", async () => {
    const home = await makeTmpHome("read");
    const env = isolatedEnv(home);
    assert.equal(readAuthToken(env).token, null);
    await initAuthToken(env);
    const r = readAuthToken(env);
    assert.match(r.token!, /^[0-9a-f]{64}$/);
  });

  it("resolveAuthToken prefers MILL_AUTH_TOKEN env over the file", async () => {
    const home = await makeTmpHome("resolve");
    const env = isolatedEnv(home, "from-env-token");
    await initAuthToken({ MILL_HOME: home } as NodeJS.ProcessEnv);
    assert.equal(resolveAuthToken({ env }), "from-env-token");
  });

  it("isAuthEnabled tracks token presence", async () => {
    const home = await makeTmpHome("enabled");
    const env = isolatedEnv(home);
    assert.equal(isAuthEnabled({ env }), false);
    await initAuthToken(env);
    assert.equal(isAuthEnabled({ env }), true);
  });
});

describe("session lifecycle in the store", () => {
  it("create / find / touch / delete round-trips", () => {
    const store = inMemStore();
    const id = generateSessionId();
    const now = Date.now();
    const created = store.createAuthSession({
      id,
      actor: "alice",
      expires_at: now + 60_000,
    });
    assert.equal(created.actor, "alice");

    const found = store.findAuthSession(id);
    assert.ok(found);
    assert.equal(found!.actor, "alice");

    const touched = store.touchAuthSession(id, now + 120_000);
    assert.ok(touched);
    assert.equal(touched!.expires_at, now + 120_000);

    store.deleteAuthSession(id);
    assert.equal(store.findAuthSession(id), null);
    store.close();
  });

  it("findAuthSession treats expired rows as missing", () => {
    const store = inMemStore();
    const id = generateSessionId();
    store.createAuthSession({
      id,
      actor: "bob",
      expires_at: Date.now() - 1000, // already expired
    });
    assert.equal(store.findAuthSession(id), null);
    store.close();
  });

  it("deleteAllAuthSessions clears every row (used by `mill auth rotate`)", () => {
    const store = inMemStore();
    const a = generateSessionId();
    const b = generateSessionId();
    store.createAuthSession({ id: a, actor: "a", expires_at: Date.now() + 60_000 });
    store.createAuthSession({ id: b, actor: "b", expires_at: Date.now() + 60_000 });
    store.deleteAllAuthSessions();
    assert.equal(store.findAuthSession(a), null);
    assert.equal(store.findAuthSession(b), null);
    store.close();
  });

  it("deleteExpiredAuthSessions sweeps only the expired rows", () => {
    const store = inMemStore();
    const old = generateSessionId();
    const fresh = generateSessionId();
    const now = Date.now();
    store.createAuthSession({ id: old, actor: "x", expires_at: now - 1 });
    store.createAuthSession({ id: fresh, actor: "y", expires_at: now + 60_000 });
    const removed = store.deleteExpiredAuthSessions(now);
    assert.equal(removed, 1);
    // fresh still present
    const r = store.findAuthSession(fresh);
    assert.ok(r);
    store.close();
  });
});

// Helper: mount the auth middleware on a tiny app with two routes — a
// public bypass at /healthz and a private one at /api/v1/runs. Returns
// the app + the store so tests can mutate sessions out-of-band.
function buildMiddlewareApp(env: NodeJS.ProcessEnv): {
  app: Hono;
  store: SqliteStateStore;
} {
  const store = inMemStore();
  const app = new Hono();
  app.use("*", buildAuthMiddleware({ store, env }));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/api/v1/runs", (c) =>
    c.json({ ok: true, actor: getActor(c) }),
  );
  app.get("/api/v1/auth/session", (c) => c.json({ login: true }));
  return { app, store };
}

async function fetchPath(
  app: Hono,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await app.fetch(new Request(`http://localhost${path}`, init));
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* leave raw */
  }
  return { status: res.status, body, headers: res.headers };
}

describe("buildAuthMiddleware allow/deny matrix", () => {
  it("AC-1: with no token configured, the middleware is a no-op", async () => {
    const { app } = buildMiddlewareApp({ MILL_HOME: "/nonexistent-mill-home" });
    const r = await fetchPath(app, "/api/v1/runs");
    assert.equal(r.status, 200);
  });

  it("AC-2: with a token configured, requests without auth get 401", async () => {
    const { app } = buildMiddlewareApp({ MILL_AUTH_TOKEN: "secret" });
    const r = await fetchPath(app, "/api/v1/runs");
    assert.equal(r.status, 401);
  });

  it("Bypass list is honored even when auth is configured", async () => {
    const { app } = buildMiddlewareApp({ MILL_AUTH_TOKEN: "secret" });
    const h = await fetchPath(app, "/healthz");
    assert.equal(h.status, 200);
    const login = await fetchPath(app, "/api/v1/auth/session");
    assert.equal(login.status, 200);
  });

  it("Authorization: Bearer with the right token authenticates", async () => {
    const { app } = buildMiddlewareApp({ MILL_AUTH_TOKEN: "secret" });
    const r = await fetchPath(app, "/api/v1/runs", {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(r.status, 200);
    assert.equal(((r.body as { actor: string }).actor), "cli");
  });

  it("Authorization: Bearer with the wrong token returns 401", async () => {
    const { app } = buildMiddlewareApp({ MILL_AUTH_TOKEN: "secret" });
    const r = await fetchPath(app, "/api/v1/runs", {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(r.status, 401);
  });

  it("Cookie session: valid sid authenticates and sets actor", async () => {
    const { app, store } = buildMiddlewareApp({ MILL_AUTH_TOKEN: "secret" });
    const sid = generateSessionId();
    store.createAuthSession({
      id: sid,
      actor: "alice",
      expires_at: Date.now() + 60_000,
    });
    const r = await fetchPath(app, "/api/v1/runs", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` },
    });
    assert.equal(r.status, 200);
    assert.equal(((r.body as { actor: string }).actor), "alice");
    store.close();
  });

  it("Cookie session: expired/missing sid returns 401 + clear-cookie", async () => {
    const { app, store } = buildMiddlewareApp({ MILL_AUTH_TOKEN: "secret" });
    const sid = generateSessionId();
    store.createAuthSession({
      id: sid,
      actor: "alice",
      expires_at: Date.now() - 1, // expired
    });
    const r = await fetchPath(app, "/api/v1/runs", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` },
    });
    assert.equal(r.status, 401);
    const setCookie = r.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie!, /Max-Age=0/);
    store.close();
  });

  it("Cookie session: touch slides expiry on every authed request", async () => {
    // Pick a real-future timestamp so the store's expiry check (which
    // uses real Date.now()) treats the row as live. The injected now()
    // only drives the middleware's slide computation.
    const now = Date.now() + 60 * 60 * 1000; // 1h from real now
    const store = inMemStore();
    const env = { MILL_AUTH_TOKEN: "secret" };
    const app = new Hono();
    app.use(
      "*",
      buildAuthMiddleware({ store, env, now: () => now }),
    );
    app.get("/api/v1/runs", (c) => c.json({ ok: true }));

    const sid = generateSessionId();
    const initialExpires = Date.now() + 5 * 60 * 1000; // 5m from real now
    store.createAuthSession({
      id: sid,
      actor: "alice",
      expires_at: initialExpires,
    });

    const res = await app.fetch(
      new Request("http://localhost/api/v1/runs", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` },
      }),
    );
    assert.equal(res.status, 200);
    const after = store.findAuthSession(sid);
    assert.ok(after);
    // Sliding expiry pushes expires_at to mockedNow + 30 days (default).
    assert.equal(
      after!.expires_at,
      now + 30 * 24 * 60 * 60 * 1000,
    );
    store.close();
  });
});

describe("getActor fallback", () => {
  it("returns 'mill' when nothing is set", () => {
    const c = mockContext({});
    // Stash a sentinel value to confirm getActor reads MILL_USER, then
    // restore.
    const orig = process.env.MILL_USER;
    delete process.env.MILL_USER;
    try {
      assert.equal(getActor(c), "mill");
    } finally {
      if (orig !== undefined) process.env.MILL_USER = orig;
    }
  });

  it("returns MILL_USER when ctx is empty", () => {
    const c = mockContext({});
    const orig = process.env.MILL_USER;
    process.env.MILL_USER = "ops-bot";
    try {
      assert.equal(getActor(c), "ops-bot");
    } finally {
      if (orig === undefined) delete process.env.MILL_USER;
      else process.env.MILL_USER = orig;
    }
  });

  it("ctx-set actor wins over env", () => {
    const c = mockContext({ "mill.actor": "alice" });
    process.env.MILL_USER = "ops-bot";
    try {
      assert.equal(getActor(c), "alice");
    } finally {
      delete process.env.MILL_USER;
    }
  });
});

// Minimal Hono Context stub for getActor — only needs `c.get(key)`.
function mockContext(state: Record<string, unknown>): import("hono").Context {
  return { get: (k: string) => state[k] } as unknown as import("hono").Context;
}
