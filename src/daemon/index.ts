import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer as createHttpsServer } from "node:https";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import {
  daemonPidPath,
  daemonPortPath,
  ensureMillRoot,
  openStore,
} from "../core/index.js";
import { loadGlobalConfig } from "../orchestrator/config.js";
import { startRunLoop } from "./run-loop.js";
import { buildServer } from "./server.js";
import { startNotifyWorker } from "./notify.js";
import { isAuthEnabled } from "./auth.js";
import {
  parseBindMode,
  readTlsMaterial,
  validateBind,
  BindConfigError,
  type ValidatedBind,
} from "./bind.js";

// Daemon entrypoint. Wires the Hono server + cross-project run loop into
// one process bound to 127.0.0.1 by default. SIGTERM/SIGINT semantics:
//   - first signal: stop the run loop from picking up new runs, stop
//     accepting new HTTP connections, wait for in-flight runs to drain.
//   - second signal: abort active runs via their AbortControllers and
//     exit non-zero immediately.
//
// Phase 3 adds --bind <loopback|lan|all>, --insecure, --cert, --key
// flags. The bind validator is the single source of truth for the
// "non-loopback requires auth" / "non-loopback requires HTTPS or
// --insecure" rules.

interface DaemonFlags {
  bind: string | undefined;
  insecure: boolean;
  cert: string | undefined;
  key: string | undefined;
}

function parseDaemonFlags(): DaemonFlags {
  // parseArgs is forgiving of unknown flags via strict: false so the
  // entrypoint stays compatible with future additions without code
  // changes here.
  const { values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      bind: { type: "string" },
      insecure: { type: "boolean" },
      cert: { type: "string" },
      key: { type: "string" },
    },
  });
  return {
    bind: values.bind as string | undefined,
    insecure: !!values.insecure,
    cert: values.cert as string | undefined,
    key: values.key as string | undefined,
  };
}

async function main(): Promise<void> {
  const flags = parseDaemonFlags();
  const config = loadGlobalConfig();
  await ensureMillRoot();
  await mkdir(dirname(config.dbPath), { recursive: true });

  // Bind validation (Phase 3 / AC-3 + AC-4). Refuse non-loopback bind
  // without auth; refuse non-loopback over plain HTTP without --insecure
  // unless TLS material is supplied. Runs before SQLite open + pidfile
  // write so a misconfigured invocation leaves no stale state behind.
  const mode = parseBindMode(flags.bind);
  if (mode === null) {
    process.stderr.write(
      `mill daemon: --bind must be loopback|lan|all, got "${flags.bind}"\n`,
    );
    process.exit(2);
  }

  let bind: ValidatedBind;
  try {
    bind = validateBind(
      {
        mode,
        authConfigured: isAuthEnabled(),
        certPath: flags.cert,
        keyPath: flags.key,
        insecure: flags.insecure,
      },
      config.daemonHost,
    );
  } catch (err) {
    if (err instanceof BindConfigError) {
      process.stderr.write(`mill daemon: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // Pidfile guard: a stale pidfile (process gone) is fine to overwrite;
  // a live one means another daemon is already running and we should
  // bail loudly so the user knows to stop it instead of fighting for
  // the bind.
  const pidPath = daemonPidPath();
  const portPath = daemonPortPath();
  if (existsSync(pidPath)) {
    const raw = readFileSync(pidPath, "utf8").trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
      process.stderr.write(
        `mill daemon: already running (pid ${pid} per ${pidPath}). ` +
          `Stop it with \`mill daemon stop\` before starting another.\n`,
      );
      process.exit(1);
    }
    // Stale pidfile from a prior crash — clear it before proceeding.
    try {
      unlinkSync(pidPath);
    } catch {
      // ignore — write below will overwrite
    }
  }

  const store = openStore(config.dbPath);
  // UI is on by default; --no-ui (via the CLI) sets MILL_NO_UI=1 in the
  // env, and MILL_DEV=1 is the dev workflow that runs Vite separately.
  const serveUi =
    process.env.MILL_NO_UI !== "1" && process.env.MILL_DEV !== "1";
  // Cookies omit `Secure` when we are NOT serving HTTPS. Browsers only
  // accept Secure cookies over TLS, so on plain HTTP (loopback default,
  // or non-loopback with --insecure) we drop the attribute.
  const insecureCookies = bind.tls === null;
  const app = buildServer({ store, config, serveUi, insecureCookies });
  const runLoop = startRunLoop({ store, config });
  // Webhook notify worker. Subscribes to the in-process event bus and
  // fans out matching events to per-project webhook subscriptions. No
  // durability — see Phase 3 plan's architectural decision 7.
  const notify = startNotifyWorker({
    store,
    publicUrl: config.publicUrl,
  });

  // Bind first; if the port is taken we want to fail before writing
  // the pidfile (so a future start sees no stale state).
  const server = await listen({
    app,
    hostname: bind.hostname,
    port: config.daemonPort,
    tls: bind.tls
      ? readTlsMaterial(bind.tls.certPath, bind.tls.keyPath)
      : null,
  });

  writeFileSync(pidPath, `${process.pid}\n`, "utf8");
  writeFileSync(portPath, `${config.daemonPort}\n`, "utf8");
  const scheme = bind.tls ? "https" : "http";
  const securityNote = bind.tls
    ? "tls"
    : bind.insecure && !bind.isLoopback
      ? "plain HTTP (--insecure)"
      : "plain HTTP";
  process.stderr.write(
    `mill daemon: listening on ${bind.hostname}:${config.daemonPort} ` +
      `(${bind.mode}, ${securityNote}, pid ${process.pid}, db ${config.dbPath})\n`,
  );
  if (serveUi) {
    process.stderr.write(
      `mill daemon: web UI at ${scheme}://${bind.hostname}:${config.daemonPort}/\n`,
    );
  }

  let shuttingDown = false;
  let aborted = false;

  const cleanupFiles = (): void => {
    for (const p of [pidPath, portPath]) {
      try {
        unlinkSync(p);
      } catch {
        // ignore
      }
    }
  };

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (!shuttingDown) {
      shuttingDown = true;
      process.stderr.write(
        `mill daemon: ${signal} received — draining ${runLoop.inFlight()} run(s). ` +
          `Send ${signal} again to abort.\n`,
      );
      runLoop.stop();
      notify.stop();
      // Stop accepting new HTTP connections; existing requests still
      // complete. Hono on @hono/node-server returns the underlying
      // http.Server.
      try {
        server.close();
      } catch {
        // ignore
      }
      try {
        await runLoop.whenDrained();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`mill daemon: drain error: ${msg}\n`);
      }
      process.stderr.write("mill daemon: drained cleanly, exiting\n");
      cleanupFiles();
      try {
        store.close();
      } catch {
        // ignore
      }
      process.exit(0);
      return;
    }
    if (!aborted) {
      aborted = true;
      process.stderr.write(
        `mill daemon: ${signal} (again) — aborting ${runLoop.inFlight()} run(s)\n`,
      );
      runLoop.abort();
      // Give the abort a brief moment to propagate, then bail.
      setTimeout(() => {
        cleanupFiles();
        process.exit(130);
      }, 500);
    }
  };
  process.on("SIGINT", (sig) => void shutdown(sig));
  process.on("SIGTERM", (sig) => void shutdown(sig));
}

interface ListenArgs {
  app: import("hono").Hono;
  hostname: string;
  port: number;
  tls: { cert: string; key: string } | null;
}

async function listen(args: ListenArgs): Promise<{ close: () => void }> {
  // serve() returns the http.Server synchronously and only emits
  // "listening" / "error" once the bind resolves. Wrap so EADDRINUSE
  // becomes a clear stderr message rather than an unhandled "error" event.
  return new Promise((resolve, reject) => {
    let settled = false;
    const opts: Parameters<typeof serve>[0] = {
      fetch: args.app.fetch,
      hostname: args.hostname,
      port: args.port,
    };
    if (args.tls) {
      // Hand off to https.createServer with the supplied cert/key. The
      // adapter still wires Hono's fetch into the request pipeline.
      opts.createServer = createHttpsServer;
      opts.serverOptions = { cert: args.tls.cert, key: args.tls.key };
    }
    const server = serve(opts, () => {
      if (settled) return;
      settled = true;
      resolve(server as unknown as { close: () => void });
    });
    (server as unknown as NodeJS.EventEmitter).on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      const code = (err as Error & { code?: string }).code;
      if (code === "EADDRINUSE") {
        process.stderr.write(
          `mill daemon: port ${args.port} on ${args.hostname} is already in use. ` +
            `Override with MILL_DAEMON_PORT=<n> or stop the other process.\n`,
        );
      } else {
        process.stderr.write(`mill daemon: bind error: ${err.message}\n`);
      }
      reject(err);
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is the POSIX "is this pid alive?" probe — doesn't send a
    // signal, just returns/throws based on existence + permissions.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    // EPERM means the process exists but we don't own it — still alive.
    return code === "EPERM";
  }
}

main().catch((err) => {
  if (err instanceof Error && (err as Error & { code?: string }).code === "EADDRINUSE") {
    // Already logged inside listen(); just exit non-zero.
    process.exit(1);
  }
  process.stderr.write(
    `mill daemon: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
