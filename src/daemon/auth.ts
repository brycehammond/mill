import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { millRoot, type AuthSessionRow, type StateStore } from "../core/index.js";

// Phase 3 auth module. The contract is intentionally narrow:
//   1. Bearer-token compare (constant-time) for CLI / programmatic clients.
//   2. Cookie-backed session lifecycle for the web UI.
//   3. A Hono middleware that enforces (1) OR (2) when auth is enabled.
// All auth state is in-process: the token comes from MILL_AUTH_TOKEN (or
// the on-disk file at ~/.mill/auth.token), session rows live in the
// `auth_sessions` table on the central DB.
//
// Auth is all-or-nothing in Phase 3. If a token is configured, every
// /api/v1/* request needs proof. If not, every request goes through
// (Phase 1/2 behavior — auth opt-in, AC-17).

export const AUTH_TOKEN_FILENAME = "auth.token";
export const SESSION_COOKIE_NAME = "mill_session";

// Default to 30 days, configurable via MILL_SESSION_LIFETIME_DAYS.
const DEFAULT_SESSION_LIFETIME_DAYS = 30;

// Paths we never auth-gate. Auth setup endpoints and the unauthenticated
// healthz are open so the UI can render the login screen and curl probes
// keep working when auth is on.
const AUTH_BYPASS_PREFIXES = [
  "/healthz",
  "/api/v1/health",
  "/api/v1/auth/session",
];

function authBypass(path: string): boolean {
  for (const p of AUTH_BYPASS_PREFIXES) {
    if (path === p || path.startsWith(p + "/")) return true;
  }
  return false;
}

// Resolve the configured token. MILL_AUTH_TOKEN wins; otherwise we read
// ~/.mill/auth.token if present. Returns null when no token has been
// provisioned (auth disabled, AC-1).
export interface ResolveAuthOpts {
  env?: NodeJS.ProcessEnv;
}

export function authTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(millRoot(env), AUTH_TOKEN_FILENAME);
}

export function resolveAuthToken(opts: ResolveAuthOpts = {}): string | null {
  const env = opts.env ?? process.env;
  const fromEnv = env.MILL_AUTH_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const file = authTokenPath(env);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function isAuthEnabled(opts: ResolveAuthOpts = {}): boolean {
  return resolveAuthToken(opts) !== null;
}

// Constant-time bearer-token compare. Length mismatch short-circuits to
// `false` BUT still does a dummy compare so the timing channel doesn't
// leak the configured token's length.
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Run a same-length compare on a throwaway so we don't bail early.
    const dummy = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, dummy);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Generate a fresh 32-byte random token, hex-encoded (64 chars).
export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}

// Generate a session id. 32 random bytes hex-encoded. The id is what
// lands in the cookie and the auth_sessions table.
export function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

// Session lifetime in milliseconds, derived from
// MILL_SESSION_LIFETIME_DAYS (default 30).
export function sessionLifetimeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MILL_SESSION_LIFETIME_DAYS;
  let days = DEFAULT_SESSION_LIFETIME_DAYS;
  if (raw && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) days = n;
  }
  return Math.floor(days * 24 * 60 * 60 * 1000);
}

// Hand-rolled cookie parser. RFC 6265 cookies are simply
// `name=value; name=value`; we split on `;` and trim. No URL-decoding
// of values — the session id we issue is hex, so this is safe.
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

// Build the Set-Cookie value for a freshly-issued session. HttpOnly +
// SameSite=Strict + Path=/ are unconditional. `Secure` is added unless
// the caller passed `insecure: true` — when the daemon binds plain HTTP
// on loopback the browser still accepts the cookie without `Secure`,
// which is what local dev needs.
export interface IssueCookieOpts {
  insecure?: boolean;
  maxAgeMs: number;
}

export function buildSessionCookie(
  sessionId: string,
  opts: IssueCookieOpts,
): string {
  const maxAgeSec = Math.max(1, Math.floor(opts.maxAgeMs / 1000));
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSec}`,
  ];
  if (!opts.insecure) parts.push("Secure");
  return parts.join("; ");
}

// Set-Cookie value that clears the session cookie (logout / 401).
export function buildClearSessionCookie(opts: { insecure?: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  if (!opts.insecure) parts.push("Secure");
  return parts.join("; ");
}

// Hono context keys the middleware writes to so downstream handlers
// (or the shared `getActor` helper) can read who is making the request.
//
// `actor` is set whenever auth is enabled AND the request authenticated
// successfully. With auth disabled, the middleware is bypassed and
// `actor` is unset; callers default to `MILL_USER` (or 'mill').
export const ACTOR_KEY = "mill.actor";
export const SESSION_KEY = "mill.session";

// Public helper for other modules (state-eng's approve/reject endpoints).
// Always returns a non-empty string: the session actor for cookie auth,
// the env var MILL_USER for unauthenticated local dev, otherwise 'mill'.
export function getActor(c: Context): string {
  const fromCtx = c.get(ACTOR_KEY) as string | undefined;
  if (fromCtx && fromCtx.trim()) return fromCtx.trim();
  const env = process.env.MILL_USER;
  if (env && env.trim()) return env.trim();
  return "mill";
}

// Read the cookie session row from the Hono context. Only set when the
// request authenticated via a session cookie (Bearer-token requests
// have no session). Useful for routes that want to surface who is
// logged in without parsing the cookie themselves.
export function getSession(c: Context): AuthSessionRow | null {
  const v = c.get(SESSION_KEY) as AuthSessionRow | undefined;
  return v ?? null;
}

// Build the Hono middleware. The middleware is a no-op when auth is
// disabled (token unset). When enabled it accepts either:
//   - Authorization: Bearer <token>  -> actor = "cli" (or MILL_USER)
//   - Cookie: mill_session=<id>      -> actor = the session row's actor
// Anything else is 401.
//
// Successful cookie authentications slide the expiry by sessionLifetimeMs.
// `now()` is injected for tests; the bypass list is fixed.
export interface BuildMiddlewareOpts {
  store: StateStore;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export function buildAuthMiddleware(
  opts: BuildMiddlewareOpts,
): MiddlewareHandler {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  return async (c, next) => {
    const token = resolveAuthToken({ env });
    // AC-1: with no token configured, the middleware is a no-op.
    if (!token) return await next();

    const path = new URL(c.req.url).pathname;
    if (authBypass(path)) return await next();

    // 1. Authorization: Bearer <token>
    const authHeader = c.req.header("authorization");
    if (authHeader) {
      const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (m && m[1] && constantTimeEqual(m[1].trim(), token)) {
        // Bearer requests come from CLI / programmatic clients. We use
        // MILL_USER if the operator set it; otherwise tag as "cli" so
        // audit events still have a non-empty actor.
        c.set(
          ACTOR_KEY,
          (env.MILL_USER && env.MILL_USER.trim()) || "cli",
        );
        return await next();
      }
      return c.json({ error: "invalid bearer token" }, 401);
    }

    // 2. Cookie session
    const cookieHeader = c.req.header("cookie");
    const cookies = parseCookies(cookieHeader);
    const sid = cookies[SESSION_COOKIE_NAME];
    if (sid) {
      const session = opts.store.findAuthSession(sid);
      if (session) {
        // Slide the expiry on every authenticated request.
        const newExp = now() + sessionLifetimeMs(env);
        const touched = opts.store.touchAuthSession(sid, newExp) ?? session;
        c.set(ACTOR_KEY, touched.actor);
        c.set(SESSION_KEY, touched);
        return await next();
      }
      // Cookie present but session is missing/expired — clear it so the
      // browser stops sending it and the UI flips to the login screen.
      c.header("Set-Cookie", buildClearSessionCookie({ insecure: true }));
      return c.json({ error: "session expired" }, 401);
    }

    return c.json({ error: "authentication required" }, 401);
  };
}

// ---- on-disk token file ----

export interface InitTokenResult {
  path: string;
  token: string;
  created: boolean;
}

// Write a fresh token to ~/.mill/auth.token at mode 0600. Refuses to
// overwrite an existing file - callers must call `rotateAuthToken` to
// replace.
export async function initAuthToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<InitTokenResult> {
  const file = authTokenPath(env);
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    return { path: file, token: existing, created: false };
  }
  await mkdir(dirname(file), { recursive: true });
  const token = generateAuthToken();
  await writeFile(file, token + "\n", "utf8");
  await chmod(file, 0o600);
  return { path: file, token, created: true };
}

// Replace the on-disk token. Caller is responsible for invalidating
// existing sessions via `store.deleteAllAuthSessions()` (the CLI does).
export async function rotateAuthToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<InitTokenResult> {
  const file = authTokenPath(env);
  await mkdir(dirname(file), { recursive: true });
  const token = generateAuthToken();
  await writeFile(file, token + "\n", "utf8");
  await chmod(file, 0o600);
  return { path: file, token, created: true };
}

// Read the on-disk token. Returns null when the file is missing.
export function readAuthToken(
  env: NodeJS.ProcessEnv = process.env,
): { path: string; token: string | null } {
  const file = authTokenPath(env);
  if (!existsSync(file)) return { path: file, token: null };
  const raw = readFileSync(file, "utf8").trim();
  return { path: file, token: raw.length > 0 ? raw : null };
}
