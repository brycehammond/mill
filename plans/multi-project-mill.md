# Multi-project mill

Restructure mill from a per-repository tool into a host-level service that manages multiple project repositories from one place, with a small daemon that the CLI talks to. This file is the requirement for **Phase 1** of that restructure. A web UI is the next phase and is **out of scope** for this run.

## Problem

Today mill is rooted in a single repo: `MILL_ROOT` discovers `.mill/` by walking up from cwd, every run lives in `<repo>/.mill/`, the worker only knows about the project it was started in, and there's no way to see runs across projects without `cd`-ing between them. Cost rollups, the journal, and the findings ledger are all per-repo.

The user wants mill to behave more like a host-level service: register N project repos with mill once, then drive runs against any of them from one place, with shared budgets, a shared findings ledger, and a single daemon that orchestrates work for all projects.

## Goal

After this phase, mill state lives centrally at `~/.mill/`, projects are first-class entities the user registers, every CLI command operates against a chosen project, and a long-running `mill daemon` process owns run execution and exposes a localhost HTTP API the CLI talks to. No web UI yet — the daemon is the foundation the UI will later sit on.

## Background

mill's current architecture (see `CLAUDE.md`) is a CLI + a `worker.ts` queue puller, both reading/writing one SQLite DB at `<repo>/.mill/mill.db`. The orchestrator (`pipeline.ts`, `stages/*`, `critics/*`) is project-agnostic — it operates on a `ctx.root` and a run id. The schema tables (`runs`, `stages`, `events`, `findings`, …) are all keyed by `run_id` already.

The structural shift is: introduce a `projects` table, add `project_id` to `runs`, move durable per-project state (`journal.md`, `decisions.md`, `profile.json`, `stitch.json`) under `~/.mill/projects/<project-id>/`, and split today's CLI into a thin client + a daemon. The orchestrator stays untouched.

**One non-obvious constraint:** Claude Code's CLAUDE.md auto-discovery walks up from cwd. Today this works because the workdir is `<repo>/.mill/runs/<id>/workdir/` — inside the project repo. We must preserve this. Workdirs stay in the project repo; only the **management state** (DB, journal, registry) moves to `~/.mill/`. See "Architectural decisions" below.

## In scope (Phase 1)

1. **Central state at `~/.mill/`.** Single SQLite DB at `~/.mill/mill.db`. Per-project durable files at `~/.mill/projects/<project-id>/{journal.md, decisions.md, profile.json, stitch.json}`. The repo-local `.mill/` directory is reduced to **runs only**: `<repo>/.mill/runs/<id>/workdir/` for the active workdir and `<repo>/.mill/runs/<id>/{KILLED, verify/, …}` for run-scoped artifacts. Repo-local `.mill/mill.db`, `journal.md`, `decisions.md`, `profile.json`, `stitch.json` go away.

2. **Projects as first-class entities.**
   - New `projects` table: `id`, `name`, `root_path` (absolute, unique), `added_at`, `monthly_budget_usd` (nullable), `default_concurrency` (nullable).
   - `runs.project_id` column (foreign key to `projects.id`), backfilled during migration.
   - Helpers in `core/project.ts` to resolve projects by id, by name, or by cwd (walk up to find a `root_path` match).

3. **CLI commands for project management.**
   - `mill project add [<path>]` registers a repo (defaults to cwd). Validates it's a git repo. Generates a stable id (slug of `basename` + 4-char hash, dedup on collision). Migrates any existing repo-local `.mill/` state into the central DB (see "Migration" below).
   - `mill project ls` lists registered projects with cost rollup (today / MTD), runs in flight, and last delivery.
   - `mill project rm <id>` deregisters (keeps history rows; sets a `removed_at` timestamp; future `ls` hides by default, `--all` shows).
   - `mill project show <id>` prints details including the resolved paths.

4. **Project resolution for existing commands.** All run-scoped commands (`mill new`, `mill run`, `mill status`, `mill tail`, `mill logs`, `mill kill`, `mill findings`, `mill history`, `mill onboard`) accept an optional `--project <id|name|path>`. If omitted, mill resolves the project from cwd. If cwd is inside a registered project, it's used; otherwise a clear error directs the user to `--project` or `mill project add`.

5. **Daemon process.**
   - `mill daemon start [--port <n>] [--host 127.0.0.1]` starts the long-running daemon. Default `127.0.0.1:7333`. Writes a pidfile at `~/.mill/daemon.pid`.
   - `mill daemon stop` sends SIGTERM, waits for graceful drain (same semantics as today's worker SIGINT/SIGTERM behavior), then exits.
   - `mill daemon status` prints "running on port X (pid Y)" or "not running".
   - The daemon takes over the run-execution loop currently in `worker.ts`. Given the central DB, it sees runs across all projects; concurrency is enforced by a global cap (`MILL_MAX_CONCURRENT_RUNS`, default 2) and an optional per-project cap (`projects.default_concurrency`).

6. **HTTP API (internal, localhost-only).** Phase 1 is "just enough for the CLI to talk to the daemon." No auth, bound to loopback only. The CLI becomes a thin client; if the daemon isn't running, command-line operations that need the daemon fail with a clear error and "run `mill daemon start`" hint. Endpoints:
   - `POST /projects` — register a project. Body: `{root_path, name?, monthly_budget_usd?, default_concurrency?}`. Response: full project row.
   - `GET /projects` — list projects (with cost rollup, runs in flight, last delivery).
   - `GET /projects/:id` / `DELETE /projects/:id`.
   - `POST /projects/:id/runs` — create a run (replaces today's intake). Body: `{requirement, mode?, stop_after?, all_defaults?}`. Returns the new run id and (if applicable) clarification questions.
   - `POST /runs/:id/clarifications` — submit answers, transitions run from `awaiting_clarifications` to `running`.
   - `GET /runs?project=<id>&status=<...>&limit=<n>` — list runs.
   - `GET /runs/:id` — run detail (run row + stages + costs + findings counts).
   - `GET /runs/:id/events?since=<event_id>` — page through events (no SSE in Phase 1; SSE is Phase 2 along with the UI).
   - `POST /runs/:id/kill` — write `KILLED` sentinel, same semantics as `mill kill` today.
   - `GET /findings?project=<id>&limit=<n>` — cross-project ledger view.

7. **CLI ↔ daemon transport.** All CLI commands that read/write live run state route through the daemon HTTP API. Pure introspection commands that only need the DB (`mill status`, `mill findings`, `mill history`) **may** open the SQLite DB read-only directly so they work when the daemon is stopped — this is a quality-of-life concession; they should not write.

8. **Migration on `mill project add`.** When a registered repo has an existing `.mill/mill.db` (legacy per-repo install), `mill project add` imports its contents into the central DB:
   - All `runs`, `stages`, `stage_iterations`, `events`, `findings`, `suppressed_findings`, `clarifications`, `sessions` rows are inserted with the new `project_id` set. Run ids are kept (they're already timestamp-based; we accept a small risk of collision and dedup on `id`).
   - `<repo>/.mill/journal.md`, `decisions.md`, `profile.json`, `stitch.json` are copied to `~/.mill/projects/<id>/` (overwriting only if the destination is empty; otherwise the central versions win and the user is warned).
   - `<repo>/.mill/runs/` is left in place — workdirs for past runs stay where they are, since the run rows still reference them.
   - The legacy `<repo>/.mill/mill.db` is moved to `<repo>/.mill/mill.db.legacy-<timestamp>` (kept, not deleted).
   - `mill init` is renamed to `mill project add` with `mill init` left as a deprecated alias that prints a one-line note and invokes `mill project add`.

9. **Tests pass and the existing CLI surface still works.** Every command listed in `mill --help` today must still function for users with a single registered project. The user experience for "I just want to run mill in this one repo" should be: `mill project add` once, then `mill new "..."` works as before.

## Acceptance criteria

These are testable bullets the spec stage should refine; mill's spec2tests will write failing tests against them.

- **AC-1** `mill project add /path/to/repo` creates a row in `~/.mill/mill.db::projects`, generates a stable id, and is idempotent (second add of same path is a no-op with a clear "already registered" message).
- **AC-2** `mill project ls` shows registered projects with computed cost-rollup columns; output is stable enough for snapshot testing.
- **AC-3** With no projects registered, `mill new "..."` fails with a clear message telling the user to register a project first.
- **AC-4** With one project registered, `mill new "..."` (run from inside that project's repo) creates a run with `runs.project_id` set, just like today's flow.
- **AC-5** `mill new --project <id> "..."` works from any cwd.
- **AC-6** `mill daemon start` binds to 127.0.0.1, writes a pidfile, and is detectable by `mill daemon status`. `mill daemon stop` shuts it down cleanly.
- **AC-7** With the daemon running, all CLI commands that mutate state (new, run, kill, project add/rm, clarifications) succeed by talking to the daemon HTTP API. Network failure to the daemon produces a clear error.
- **AC-8** With the daemon **not** running, `mill status`, `mill findings`, `mill history`, and `mill project ls` still work (read-only direct DB access). Mutating commands fail with a "start the daemon" hint.
- **AC-9** `mill project add` against a repo with a legacy `<repo>/.mill/mill.db` migrates all rows into the central DB and renames the legacy file to `mill.db.legacy-<ts>`. A second `mill project add` on the same repo does not double-import.
- **AC-10** Per-project state files (`journal.md`, `decisions.md`, `profile.json`, `stitch.json`) live at `~/.mill/projects/<id>/` and are read/written by the existing helpers (`core/journal.ts`, `core/decisions.ts`, `core/profile.ts`, `core/stitch.ts`) via a project-aware path resolver.
- **AC-11** Workdirs remain at `<repo>/.mill/runs/<id>/workdir/`. CLAUDE.md auto-discovery from inside a workdir still finds the project's `CLAUDE.md` (verify with a fixture: place a `CLAUDE.md` in a temp git repo, run a synthetic stage, assert the prompt path includes it).
- **AC-12** Concurrency: with two projects each enqueuing two runs and a global cap of 2, the daemon runs at most 2 in parallel and queues the rest.
- **AC-13** The orchestrator (`pipeline.ts`, all `stages/*`, all `critics/*`) is unchanged in behavior. Existing test suites pass (`store.sqlite.test.ts`, `claude-cli.test.ts`, `review.test.ts`, etc.) — any modifications are limited to constructor signatures that accept a project-aware path resolver instead of a hard-coded `ctx.root`-derived path.
- **AC-14** Documentation: `README.md`, `CLAUDE.md`, and `.env.example` are updated to reflect the new model. `npm run mill -- --help` reflects the new command surface.

## Architectural decisions (already made — do not re-derive)

1. **DB at `~/.mill/mill.db`, single source of truth for management state.** Not a registry pointing at per-repo DBs.

2. **Workdirs stay in the project repo at `<repo>/.mill/runs/<id>/workdir/`.** This preserves CLAUDE.md auto-discovery and keeps the existing `git worktree add` flow for edit-mode runs unchanged. Repos still have a `.mill/runs/` directory, but no DB or journal there.

3. **Daemon transport is HTTP on localhost.** Not a Unix socket (cross-platform), not gRPC (overkill). Fastify or Hono on Node, picker's choice — Hono is preferred because Phase 2 needs SSE and Hono's SSE story is cleaner.

4. **The orchestrator is unchanged.** Stages, critics, retry, the pipeline driver — none of these need to know about projects. Project-awareness lives in the path resolver and the run row.

5. **CLI stays the entrypoint; daemon is a separate process.** Not an embedded daemon that auto-starts on first call (too magical for Phase 1, and pidfile races are real). Users start the daemon explicitly. A future phase may add auto-start.

6. **Migration is non-destructive.** Legacy `.mill/mill.db` is renamed, not deleted. Workdirs are not relocated.

7. **Read paths can bypass the daemon.** Read-only CLI commands open the DB directly so observation works when the daemon is down. Write paths must go through the daemon (single writer to avoid `database is locked` races).

8. **Phase 1 has no auth, no SSE, no web UI.** Loopback bind is the only access control. SSE and the React UI are Phase 2.

## Out of scope

- Web UI (Phase 2).
- Server-Sent Events / live event streaming over HTTP (Phase 2; in Phase 1 the CLI's `tail -f` keeps polling the DB as it does today).
- Auth or remote access (Phase 3).
- Approval gates between stages (Phase 3).
- Per-project budgets enforced as hard stops (Phase 3 — Phase 1 only stores the value).
- Multi-user / multi-tenant.
- Routine scheduling / cron triggers.
- Plugin model.
- Migrating workdirs out of the project repo.
- Renaming the binary, splitting npm packages, or any other structural reorg beyond what's needed for the above.

## Constraints

- **Existing test suites must continue to pass.** Update test fixtures where they hard-code `<repo>/.mill/...` paths, but do not weaken assertions.
- **TypeScript conventions in `CLAUDE.md` are ground truth.** Every relative `.ts` import keeps its `.js` extension; `noUncheckedIndexedAccess` patterns are preserved; no new imports without `.js` suffix.
- **No new runtime dependencies beyond the daemon's HTTP framework.** Hono (or Fastify) + its peer deps only. No ORMs, no DI containers.
- **Crash recovery still works.** SIGTERM on the daemon must drain in-flight runs cleanly (same two-signal semantics as today's worker). A run interrupted mid-stage must resume on the next daemon start without losing cost/usage.
- **No silent breaking changes for solo users.** A user who today has one repo with `.mill/` should be able to run `mill project add` once and have everything keep working.
- **CLAUDE.md is loaded by `claude`, not by mill.** Don't inline its content into prompts; the existing pattern (stage prompts reference it as ground truth) stays.

## Open questions

These should be surfaced by the clarification stage and answered before design:

1. **CLI default behavior when no project is registered:** should `mill new` from inside a git repo *prompt* to register the current repo, or fail with an error? (Lean: prompt, with a `--no-auto-register` escape.)
2. **Daemon port collision:** if 7333 is taken, fall back to next available and write the chosen port to `~/.mill/daemon.port`, or fail loudly?
3. **`mill init` deprecation:** keep it as an alias indefinitely, or print a warning and remove in N+1?
4. **Migration of repo-local journal/decisions when both sides have content:** central wins (current preference) vs. append-and-dedupe vs. ask the user.
5. **Project id format:** human-readable slug (`mill`, `dark-factory`) or opaque (`prj_a8f2…`)? (Lean: slug + short hash for dedup, e.g. `mill-a8f2`.)
6. **Concurrency precedence:** if a project sets `default_concurrency=4` but the global cap is 2, does the global cap win? (Lean: yes, global is a hard ceiling.)
7. **Should `mill onboard` write the profile to the central path immediately, or to a temp location that `mill project add` then imports?** (The second is cleaner for fresh repos that aren't yet registered.)

## References (files this will touch)

- `src/cli.ts` — split mutating commands to talk to the daemon over HTTP; add `mill project` and `mill daemon` subcommands.
- `src/orchestrator/worker.ts` — replaced by the daemon entrypoint (likely renamed to `src/orchestrator/daemon.ts`).
- `src/orchestrator/config.ts` — `MILL_ROOT` discovery becomes "find the central `~/.mill/` path"; new envs for daemon port/host.
- `src/orchestrator/context.ts` — `ctx.root` becomes project-aware via the new path resolver.
- `src/core/store.sqlite.ts` — schema migration (add `projects`, add `runs.project_id`), new `projects` CRUD methods, project-scoped query variants.
- `src/core/project.ts` — extend with `addProject`, `findProjectByPath`, `resolveProjectFromCwd`, etc.
- `src/core/paths.ts` — central path helpers (`millRoot()`, `projectStateDir(id)`, `projectJournal(id)`).
- `src/core/journal.ts`, `decisions.ts`, `profile.ts`, `stitch.ts` — accept project id (or resolved paths), drop assumption of `<repo>/.mill/`.
- `src/orchestrator/intake.ts` — runs creation flow becomes project-scoped.
- New: `src/daemon/server.ts` — HTTP routes, request handlers.
- New: `src/cli/client.ts` — thin HTTP client used by the mutating CLI commands.
- New: `src/core/migrate.ts` — legacy `.mill/` import logic for `mill project add`.

The orchestrator pipeline (`pipeline.ts`, `stages/*`, `critics/*`, `retry.ts`, `claude-cli.ts`, `guard.ts`, `run-settings.ts`, `progress.ts`) should not need behavioral changes. If a stage hard-codes a `<repo>/.mill/...` path that's now under `~/.mill/projects/<id>/...`, route it through the new path helper — but no logic changes.
