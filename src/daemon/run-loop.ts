import { buildContext } from "../orchestrator/context.js";
import { runPipeline } from "../orchestrator/pipeline.js";
import type { GlobalMillConfig, MillConfig } from "../orchestrator/config.js";
import { projectStateDir, type ProjectRow, type StateStore } from "../core/index.js";

// Cross-project run loop. Same shape as the legacy worker.ts but polls
// for `running` runs across the whole central DB rather than a single
// project's. Concurrency limits:
//   - global cap (config.maxConcurrentRuns) is the hard ceiling.
//   - per-project cap (project.default_concurrency) is bounded by the
//     global cap — when both are set, min(global free, project free).
// The loop is idempotent on resume: a run already being executed (its
// id is in `active`) is skipped on the next tick, so multiple polls of
// the same row are safe.

export interface RunLoopHandle {
  // Resolves when the loop has fully drained after `stop()` was called.
  whenDrained(): Promise<void>;
  // First call: stop accepting new runs (existing keep going). Second
  // call: abort their AbortControllers. Mirrors worker.ts's two-signal
  // SIGTERM semantics.
  stop(): void;
  abort(): void;
  // Snapshot for debugging / status routes.
  inFlight(): number;
}

export interface RunLoopOpts {
  store: StateStore;
  config: GlobalMillConfig;
  // Override for tests so the loop can be exercised without spawning
  // real `claude` subprocesses. Defaults to runPipeline. Returns when
  // the run is done — same contract as runPipeline.
  pipeline?: (args: PipelineArgs) => Promise<unknown>;
  // Override for tests so the loop can be exercised against in-memory
  // contexts. Defaults to buildContext.
  buildCtx?: typeof buildContext;
  // Poll interval. The default mirrors worker.ts (2s). Set lower in
  // tests so cap-enforcement assertions don't sit on real timers.
  pollIntervalMs?: number;
  // Logger; defaults to writing to stderr.
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
}

interface PipelineArgs {
  runId: string;
  config: MillConfig;
  ctx: Awaited<ReturnType<typeof buildContext>>;
}

// Build the project-scoped MillConfig that runPipeline expects from a
// global config + a resolved project row. Avoids re-running cwd-based
// project resolution inside loadConfig (which would fail since the
// daemon serves runs from any cwd).
function buildMillConfig(global: GlobalMillConfig, project: ProjectRow): MillConfig {
  return {
    ...global,
    project,
    projectId: project.id,
    root: project.root_path,
    stateDir: projectStateDir(project.id),
  };
}

export function startRunLoop(opts: RunLoopOpts): RunLoopHandle {
  const {
    store,
    config,
    pipeline = (args) => runPipeline(args),
    buildCtx = buildContext,
    pollIntervalMs = 2000,
    logger = (msg, meta) => {
      const tail = meta ? ` ${JSON.stringify(meta)}` : "";
      process.stderr.write(`run-loop: ${msg}${tail}\n`);
    },
  } = opts;

  const active = new Map<
    string,
    { promise: Promise<unknown>; projectId: string | null; controller: AbortController }
  >();
  let stopped = false;
  let aborted = false;
  let drained: () => void = () => {};
  const drainPromise = new Promise<void>((resolve) => {
    drained = resolve;
  });

  // ----- the actual poll loop -----
  // unref'd so the loop alone won't keep the process alive — useful in
  // tests, harmless in production where the HTTP server's listening
  // socket is the load-bearing reason the process stays up.
  let pollTimer: NodeJS.Timeout | null = null;
  const armTimer = (delayMs: number): void => {
    pollTimer = setTimeout(tick, delayMs);
    if (typeof (pollTimer as { unref?: () => void }).unref === "function") {
      (pollTimer as { unref: () => void }).unref();
    }
  };
  const tick = (): void => {
    pollTimer = null;
    if (stopped) {
      if (active.size === 0) {
        drained();
        return;
      }
      // While stopped, keep checking until in-flight runs drain.
      armTimer(pollIntervalMs);
      return;
    }
    try {
      schedule();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger("schedule error", { err: msg });
    }
    armTimer(pollIntervalMs);
  };

  function schedule(): void {
    if (active.size >= config.maxConcurrentRuns) return;
    const running = store.listRuns({ status: "running", limit: 100 });
    if (running.length === 0) return;
    // Per-project caps: count how many runs are already in flight for
    // each project so we can subtract from the project's quota.
    const inFlightByProject = new Map<string, number>();
    for (const a of active.values()) {
      if (!a.projectId) continue;
      inFlightByProject.set(
        a.projectId,
        (inFlightByProject.get(a.projectId) ?? 0) + 1,
      );
    }
    // Cache project rows per tick — listRuns can return many runs from
    // the same project, no need to hit the DB once per row.
    const projectCache = new Map<string, ProjectRow | null>();

    for (const run of running) {
      if (active.size >= config.maxConcurrentRuns) break;
      if (active.has(run.id)) continue;

      const projectId = run.project_id;
      if (projectId) {
        let project = projectCache.get(projectId);
        if (project === undefined) {
          project = store.getProject(projectId);
          projectCache.set(projectId, project);
        }
        if (project && typeof project.default_concurrency === "number") {
          const used = inFlightByProject.get(projectId) ?? 0;
          if (used >= project.default_concurrency) continue;
        }
        inFlightByProject.set(
          projectId,
          (inFlightByProject.get(projectId) ?? 0) + 1,
        );
      }

      // Stake the slot synchronously so a concurrent tick can't see this
      // row as available; if buildContext or pipeline rejects, the
      // .finally below clears it.
      const placeholder = new AbortController();
      active.set(run.id, {
        promise: Promise.resolve(),
        projectId,
        controller: placeholder,
      });
      const project = projectId ? projectCache.get(projectId) ?? null : null;
      void launch(run.id, project);
    }
  }

  async function launch(runId: string, project: ProjectRow | null): Promise<void> {
    try {
      const ctx = await buildCtx({ runId, config, store });
      const slot = active.get(runId);
      if (slot) slot.controller = ctx.abortController;
      // Honor a stop-before-build: if we entered shutdown after staking
      // the slot, abort immediately so the pipeline observes it.
      if (aborted) ctx.abortController.abort();
      // runPipeline's `config` is a project-scoped MillConfig. The daemon
      // doesn't have a "current project" — synthesize one per run from
      // the global config + the run's project row. ctx already carries
      // root/stateDir/projectId; this just satisfies the pipeline's
      // signature so it can read timeoutSecPerRun/maxReviewIters.
      const resolvedProject =
        project ?? (ctx.projectId ? store.getProject(ctx.projectId) : null);
      if (!resolvedProject) {
        throw new Error(
          `run-loop: cannot resolve project for run ${runId} ` +
            `(ctx.projectId=${ctx.projectId})`,
        );
      }
      const millConfig = buildMillConfig(config, resolvedProject);
      const promise = pipeline({ runId, config: millConfig, ctx })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger("pipeline crashed", { runId, err: msg });
        })
        .finally(() => {
          active.delete(runId);
        });
      const cur = active.get(runId);
      if (cur) cur.promise = promise;
      await promise;
    } catch (err) {
      // buildContext failed — fail the run and free the slot so the
      // loop doesn't busy-loop on the broken row.
      const msg = err instanceof Error ? err.message : String(err);
      logger("buildContext failed", { runId, err: msg });
      try {
        store.updateRun(runId, { status: "failed" });
      } catch {
        // ignore: row may be gone
      }
      active.delete(runId);
    }
  }

  // Kick off the first tick on the next macrotask so callers can attach
  // listeners synchronously before any work happens.
  armTimer(0);

  return {
    whenDrained: () => drainPromise,
    stop: () => {
      if (stopped) return;
      stopped = true;
      // Force a tick immediately so drain check fires without waiting
      // a full poll interval when nothing is in flight.
      if (pollTimer) clearTimeout(pollTimer);
      armTimer(0);
    },
    abort: () => {
      aborted = true;
      for (const a of active.values()) a.controller.abort();
    },
    inFlight: () => active.size,
  };
}
