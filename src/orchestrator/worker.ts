import { openStore } from "../core/index.js";
import { loadConfig, NoProjectError } from "./config.js";
import { buildContext } from "./context.js";
import { runPipeline } from "./pipeline.js";

// The worker polls SQLite for runs that the user has answered clarifications
// for (status = 'running') and hasn't fully completed yet. Keeps at most
// `maxConcurrentRuns` pipelines in flight.
//
// Shutdown: first SIGINT/SIGTERM stops issuing new runs and waits for the
// active ones to finish their current stage. Second signal aborts active
// runs (via AbortController → claude subprocess SIGTERM → SIGKILL).

async function main() {
  const config = loadConfig();
  const store = openStore(config.root);

  const active = new Map<string, Promise<unknown>>();
  const activeControllers = new Set<AbortController>();
  let shuttingDown = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (!shuttingDown) {
      shuttingDown = true;
      process.stderr.write(
        `worker: ${signal} received — draining ${active.size} active run(s). ` +
          `Send ${signal} again to abort.\n`,
      );
      return;
    }
    process.stderr.write(
      `worker: ${signal} (again) — aborting ${active.size} run(s)\n`,
    );
    for (const ac of activeControllers) ac.abort();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (shuttingDown && active.size === 0) {
      process.stderr.write("worker: drained cleanly, exiting\n");
      process.exit(0);
    }

    if (!shuttingDown) {
      const running = store.listRuns({ status: "running", limit: 100 });
      for (const run of running) {
        if (active.has(run.id)) continue;
        if (active.size >= config.maxConcurrentRuns) break;
        const ctx = await buildContext({ runId: run.id, config, store });
        activeControllers.add(ctx.abortController);
        const p = runPipeline({ runId: run.id, config, ctx })
          .catch((err) => {
            ctx.logger.error("pipeline crashed", {
              err: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            active.delete(run.id);
            activeControllers.delete(ctx.abortController);
          });
        active.set(run.id, p);
      }
    }
    await sleep(2000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  if (err instanceof NoProjectError) {
    console.error(`worker: ${err.message}`);
    process.exit(1);
  }
  console.error("worker fatal:", err);
  process.exit(1);
});
