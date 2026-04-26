import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

// Phase 3 bind-mode resolver. The daemon's --bind flag picks one of:
//   - loopback (127.0.0.1, default, today's behavior)
//   - lan      (host's primary LAN IPv4 via os.networkInterfaces())
//   - all      (0.0.0.0 — listen on every interface)
//
// Any non-loopback bind requires:
//   1. An auth token (MILL_AUTH_TOKEN or ~/.mill/auth.token), AND
//   2. Either TLS via --cert/--key OR an explicit --insecure opt-in.
// Both rules are enforced here so the daemon entrypoint can fail fast
// with a single clear error before opening the port.

export type BindMode = "loopback" | "lan" | "all";

export function parseBindMode(raw: string | undefined | null): BindMode | null {
  if (!raw) return "loopback";
  const v = raw.trim().toLowerCase();
  if (v === "loopback" || v === "lan" || v === "all") return v;
  return null;
}

// Return the first non-internal IPv4 interface address. Falls back to
// loopback when no LAN interface is found (a freshly-installed VM with
// no networking, etc.) — the caller error-reports this case.
export function primaryLanIPv4(): string | null {
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    const list = ifs[name];
    if (!list) continue;
    for (const i of list) {
      if (i.internal) continue;
      // Node's NetworkInterfaceInfo declares family as the string union
      // "IPv4" | "IPv6". Older Node returned a number (4|6); the cast
      // covers both shapes so the resolver works on every supported
      // runtime without tripping noUncheckedIndexedAccess strictness.
      const family = (i as { family: string | number }).family;
      if (family === "IPv4" || family === 4) {
        return i.address;
      }
    }
  }
  return null;
}

export interface ResolvedBind {
  hostname: string;
  isLoopback: boolean;
  mode: BindMode;
}

export function resolveBindHost(
  mode: BindMode,
  envHost: string | undefined,
): ResolvedBind {
  if (mode === "loopback") {
    return {
      hostname: envHost && envHost.trim() ? envHost.trim() : "127.0.0.1",
      isLoopback: true,
      mode,
    };
  }
  if (mode === "all") {
    return { hostname: "0.0.0.0", isLoopback: false, mode };
  }
  // mode === "lan"
  const lan = primaryLanIPv4();
  if (!lan) {
    throw new BindConfigError(
      "could not resolve a primary LAN IPv4 address (no non-loopback interface found). " +
        "Use --bind loopback or --bind all to bind explicitly.",
    );
  }
  return { hostname: lan, isLoopback: false, mode };
}

export class BindConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindConfigError";
  }
}

export interface BindValidationOpts {
  mode: BindMode;
  // True when MILL_AUTH_TOKEN is set OR ~/.mill/auth.token exists. The
  // caller resolves this via auth.ts so this module stays free of the
  // auth/file dependency.
  authConfigured: boolean;
  // --cert / --key paths from the CLI. Both must be present (or absent)
  // together — half-configured TLS is a hard fail.
  certPath?: string;
  keyPath?: string;
  // --insecure flag from the CLI: explicitly accept plain HTTP on a
  // non-loopback bind. Required when no cert/key supplied.
  insecure?: boolean;
}

export interface ValidatedBind extends ResolvedBind {
  tls: { certPath: string; keyPath: string } | null;
  insecure: boolean;
}

// Apply the AC-3 / AC-4 / "non-loopback over plain HTTP" rules. Returns
// the resolved hostname + TLS material when valid; throws BindConfigError
// with a user-actionable message otherwise.
export function validateBind(
  opts: BindValidationOpts,
  envHost: string | undefined,
): ValidatedBind {
  const resolved = resolveBindHost(opts.mode, envHost);
  const tls = resolveTls(opts.certPath, opts.keyPath);

  if (resolved.isLoopback) {
    return { ...resolved, tls, insecure: !!opts.insecure };
  }

  // Non-loopback: must have auth configured.
  if (!opts.authConfigured) {
    throw new BindConfigError(
      `--bind ${opts.mode} requires authentication. Run \`mill auth init\` ` +
        `to provision a token, then export MILL_AUTH_TOKEN.`,
    );
  }

  // Non-loopback: must use TLS or explicitly opt into plain HTTP.
  if (!tls && !opts.insecure) {
    throw new BindConfigError(
      `--bind ${opts.mode} requires HTTPS or --insecure. Pass --cert/--key ` +
        `to enable TLS, or run a reverse proxy (Caddy, Cloudflare Tunnel, nginx) ` +
        `that handles termination. --insecure opts into plain HTTP at your own risk.`,
    );
  }

  return { ...resolved, tls, insecure: !!opts.insecure };
}

function resolveTls(
  certPath: string | undefined,
  keyPath: string | undefined,
): { certPath: string; keyPath: string } | null {
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new BindConfigError(
      "TLS is half-configured: pass both --cert and --key, or neither.",
    );
  }
  for (const [label, p] of [
    ["--cert", certPath],
    ["--key", keyPath],
  ] as const) {
    if (!existsSync(p)) {
      throw new BindConfigError(`${label} file not found: ${p}`);
    }
  }
  return { certPath, keyPath };
}

// Read TLS material from disk for handing to https.createServer.
// Separate from validateBind so tests can validate without touching
// the filesystem (mock cert/key files via os.tmpdir() in the test).
export function readTlsMaterial(
  certPath: string,
  keyPath: string,
): { cert: string; key: string } {
  return {
    cert: readFileSync(certPath, "utf8"),
    key: readFileSync(keyPath, "utf8"),
  };
}
