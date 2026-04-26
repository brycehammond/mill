# Multi-project mill — Phase 2: web UI

Add a web UI on top of the central daemon shipped in Phase 1, plus the live event streaming the UI depends on. After this phase, the user can register projects, queue runs, watch live progress, and inspect findings entirely from a browser. Authentication, approval gates, and budget enforcement are Phase 3 and remain out of scope.

## Prerequisites

This requires Phase 1 (`plans/multi-project-mill.md`) to be delivered:
- Central state at `~/.mill/`, `projects` table, `runs.project_id`.
- `mill daemon` process exposing the localhost HTTP API.
- All mutating CLI commands routing through the daemon.

If those aren't present, the spec stage should fail-fast and surface this as a blocker rather than rebuild Phase 1 inside Phase 2.

## Problem

Phase 1 produced a daemon and a multi-project DB but kept the CLI as the only interface. The user still has to `mill tail -f <id>` in a terminal to watch a run, `cd` into project repos to know which one is which, and read raw event logs to debug stuck runs. None of that scales to "many projects in flight" — which is exactly the case Phase 1 made possible. The user wants a single browser tab that shows everything mill is doing, lets them launch new runs without a terminal, and exposes the same observability the CLI gives but with live updates.

## Goal

After this phase, `mill daemon start` serves both the HTTP API and a web UI from the same port. The UI has four screens — dashboard, project view, run view, findings ledger — that cover the existing CLI's surface area, plus a browser-side new-run flow (including the inline clarification questions today's CLI prompts for). Live updates are pushed via Server-Sent Events; reconnecting clients catch up via standard SSE replay (`Last-Event-ID`).

## Background

The Phase 1 daemon already exposes the data the UI needs (`GET /projects`, `GET /runs`, `GET /runs/:id/events?since=...`). Phase 2 fills in the gaps:

1. **Live event push.** Today every event is written to SQLite by `core/store.sqlite.ts::insertEvent`. Phase 2 adds an in-process `EventEmitter` fired alongside that write; SSE handlers subscribe by `run_id`. SQLite stays the durable store; the emitter is purely fanout.
2. **Static asset serving.** The daemon serves the built UI bundle from the same port, with a clean split between API routes (`/api/v1/...`) and static routes (`/`, `/assets/...`).
3. **The UI itself.** A small React + Vite SPA; built artifacts go to `dist/web/` and are served by the daemon. In dev, Vite's dev server proxies API/SSE to the daemon.

Cost discipline note: every screen's data is already computable from existing tables. We are not adding new domain concepts — just rendering and live-updating what's already there.

## In scope (Phase 2)

1. **Server-Sent Events on the daemon.**
   - `GET /api/v1/runs/:id/events` returns `text/event-stream` with each row as a typed event message. Each message has an `id:` matching the `events.id` autoincrement so SSE's native replay works via `Last-Event-ID`.
   - Optional `?since=<event_id>` query param for non-SSE replay (used when the page first loads to backfill before subscribing live).
   - Reconnect protocol: client sets `Last-Event-ID` header on reconnect; server first emits any rows with `id > last_event_id` from SQLite, then attaches to the live `EventEmitter`. No gaps, no duplicates.
   - Backpressure: if a subscriber is slow, the daemon drops the connection rather than buffering unbounded. Client reconnects automatically (EventSource native).

2. **In-process event fanout.**
   - `core/store.sqlite.ts::insertEvent` fires on a module-level `EventEmitter` after the row is committed. Payload shape matches what's already in the `events` table (`id`, `run_id`, `stage`, `ts`, `kind`, `payload_json`).
   - One emitter per daemon process. SSE handlers subscribe by `run_id` and unsubscribe on disconnect.
   - Tests: emitter fires for every successful insert; emitter does not fire if the INSERT throws.

3. **Static asset serving.**
   - Daemon serves `dist/web/index.html` at `/` (and any non-`/api/`, non-`/sse/` route — SPA fallback).
   - `dist/web/assets/*` served at `/assets/*` with long-lived cache headers.
   - In dev (`MILL_DEV=1` or NODE_ENV=development), the daemon **does not** serve static files; instead, instructions in `README.md` say to run Vite's dev server on a separate port and visit that.
   - Build pipeline: `npm run build` is extended to also build the UI (`vite build` in `web/`) and the `dist/web/` output is included in the published artifact.

4. **Web UI: four screens.**

   Stack: React 18 + Vite + TypeScript + TanStack Query + Tailwind. No SSR, no Next.js, no React Router beyond the small SPA router built into TanStack Router (or hand-rolled — picker's choice; whichever is simpler).

   **(a) Dashboard (`/`)** — cross-project view.
   - Header: total cost today / MTD across all projects; runs in flight count.
   - Per-project cards: name, status badge (running / idle / failed-recently), cost today, runs in flight, last delivery timestamp, "open" link to project view.
   - Recent finding fingerprints panel: top N recurring findings across projects with project chips.

   **(b) Project view (`/projects/:id`)** — single project detail.
   - Header: project name, root path, registered timestamp, cost today / MTD.
   - "New run" form: requirement textarea, mode selector (`auto|new|edit`), `--stop-after` selector, "all defaults" toggle. Submit posts to `POST /api/v1/projects/:id/runs`. If the response includes clarification questions, the form transitions to a clarification flow (radio/text inputs for each question) and POSTs answers to `/api/v1/runs/:id/clarifications`.
   - Runs table: id, mode, status, started, duration, cost, current stage, link to run view.
   - Filters: status (running/completed/failed/awaiting_clarifications), date range, free-text on requirement.
   - Findings ledger view scoped to this project (mirror of `mill findings` output).

   **(c) Run view (`/runs/:id`)** — single run detail with live updates.
   - Header: requirement summary, mode, status, project, started/finished, total cost.
   - Stage timeline: every stage with status icon; expanding a stage shows its iterations (`stage_iterations` table) with per-iteration cost and duration.
   - Live activity feed: streams via SSE; reuses the formatting logic in `orchestrator/progress.ts`. Pauses on hover so the user can read; resumes on mouse-leave.
   - Findings panel: grouped by critic and severity; click a finding to expand its detail (file path, evidence excerpt).
   - Cost panel: per-stage breakdown matching `mill status <id>`.
   - Actions: "kill" button (calls `POST /api/v1/runs/:id/kill`, with confirm dialog); "answer clarifications" button if status is `awaiting_clarifications`.
   - Auto-scrolling activity feed; "scroll to live" button if the user has scrolled up.

   **(d) Findings ledger (`/findings`)** — cross-project recurring findings.
   - Same data as `mill findings --all` plus a project filter and a "suppress" action that POSTs to a new `POST /api/v1/findings/suppressed` endpoint.
   - List of suppressed fingerprints with un-suppress action.

5. **New endpoints needed beyond Phase 1.**
   - `GET /api/v1/runs/:id/events` (SSE stream — described above).
   - `GET /api/v1/findings/suppressed` / `POST /api/v1/findings/suppressed` / `DELETE /api/v1/findings/suppressed/:fingerprint`.
   - `GET /api/v1/dashboard` — aggregates across projects (today's cost, MTD, runs in flight, top recurring findings). Convenience endpoint that returns precomputed JSON the dashboard renders directly.
   - `GET /api/v1/projects/:id/findings` — project-scoped ledger.
   - All other UI data comes from Phase 1 endpoints.

6. **CLI changes.**
   - `mill daemon start` keeps its existing behavior; in production builds the daemon now serves the UI by default.
   - New flag `mill daemon start --no-ui` for users who want API-only.
   - `mill daemon start --port` already exists; add an `--open` flag that opens the browser to the dashboard.
   - `npm run mill -- --help` mentions the UI URL after a successful daemon start.

7. **Mobile-readable layout.**
   - All four screens render usefully on a phone-width viewport (< 480px). Tables become cards; activity feeds are scrollable; "kill" and "approve" actions remain discoverable.
   - No native app, no PWA service worker. Just responsive CSS.

## Acceptance criteria

- **AC-1** Starting the daemon serves the UI: `curl -s http://127.0.0.1:7333/` returns the SPA's `index.html`. Visiting in a browser loads the dashboard.
- **AC-2** `mill daemon start --no-ui` does **not** serve static assets; only `/api/v1/...` responds.
- **AC-3** `core/store.sqlite.ts::insertEvent` emits on the in-process emitter for every successful INSERT, with payload identical to the row stored. A unit test verifies fanout for both single and batched inserts.
- **AC-4** SSE stream: opening `GET /api/v1/runs/:id/events` against an active run emits messages in real time. Each message has an `id:` matching `events.id`. Reconnecting with `Last-Event-ID: <n>` replays missed events first, then resumes live without duplicates.
- **AC-5** SSE stream: `?since=<event_id>` returns events with id > N as a finite stream that closes after the catch-up; if the run is still active, the client reconnects to the live stream separately. (Or: a single endpoint where `?since=` is just the initial replay window before live attach. Either pattern is fine; pick one and document it.)
- **AC-6** Dashboard renders cross-project aggregates correctly: an integration test with 2 projects and runs in 3 statuses shows the right counts.
- **AC-7** Project view's "new run" form creates a run and, when clarifications are required, transitions to the clarification flow, submits answers, and the run starts (status moves to `running`).
- **AC-8** Run view's live activity feed updates when the daemon emits new events. With the run finished, the feed shows the full event history without re-opening the page.
- **AC-9** Run view's "kill" button issues `POST /api/v1/runs/:id/kill` after a confirm; subsequent events show the kill being honored; the run transitions to `failed` with reason `KILLED`.
- **AC-10** Findings ledger view shows cross-project findings; "suppress" adds a row to `suppressed_findings` and the finding disappears from the unsuppressed view.
- **AC-11** Mobile: at 375px width, all four screens are usable (no horizontal scroll on the page chrome; tables transform to cards; primary actions visible without scrolling).
- **AC-12** `npm run build` produces both the daemon JS in `dist/` and the UI bundle in `dist/web/`. The published artifact contains both.
- **AC-13** Existing CLI commands and tests continue to pass — Phase 2 must not regress Phase 1.
- **AC-14** Documentation: `README.md` shows a screenshot or a description of the UI, lists the URL after `mill daemon start`, and documents the dev workflow (Vite dev server + daemon).

## Architectural decisions (already made — do not re-derive)

1. **Event fanout via in-process EventEmitter, not pubsub via SQLite.** Polling SQLite for new events from N SSE connections won't scale and adds latency. The emitter is durable enough because the SQLite write is the source of truth — if the emitter misses a fire (it shouldn't), the next reconnect with `Last-Event-ID` recovers via the table.

2. **SSE, not WebSockets.** SSE is one-way (server → client), which is exactly what we need. Native browser support, native replay via `Last-Event-ID`, no protocol negotiation, no library dependency. WebSockets would be over-spec'd for a feed.

3. **Static UI from the daemon, not a separate web server.** Single port, single command, single artifact. Dev mode uses Vite's proxy because Vite's HMR is too valuable to give up.

4. **Stack: React + Vite + Tailwind + TanStack Query.** No SSR, no app framework. The UI is a thin renderer over typed JSON; the value is in mill's core, not the frontend complexity. TanStack Query handles cache + retry + background refresh; Tailwind handles "looks fine without a design system."

5. **No auth in Phase 2.** Loopback-only bind from Phase 1 is the only access control. Anyone with shell access on the host can already drive mill via the CLI.

6. **The dashboard endpoint is a convenience aggregate, not a separate domain.** It composes existing queries server-side so the dashboard doesn't fan out into 5 round-trips on first paint.

7. **Live event format matches the `events` table schema.** No new event types or transformations between the store and the SSE message. UI components understand the same shape `mill tail` understands.

8. **UI artifact ships in the npm package.** No separate UI package, no CDN. Users get the UI with `mill` installed; offline-capable by default.

## Out of scope

- Authentication, authorization, multi-user accounts (Phase 3).
- Binding to non-loopback addresses (Phase 3 — gated on auth being configured).
- Approval gates between stages (Phase 3).
- Per-project budget enforcement / hard stops (Phase 3).
- Notifications (webhook / Slack / email) on completion or HIGH findings (Phase 3).
- Run search across the body of events (only top-level fields filterable in Phase 2).
- File / artifact viewer for stage outputs beyond the existing finding-detail view.
- Editing project config from the UI (CLI only in Phase 2).
- Embedded CLAUDE.md / spec / design viewer.
- Native apps, PWA install, push notifications.
- SSR, server components, static site generation.
- Custom theme / dark mode toggle (one default theme is fine).
- Charts / graphs of cost over time (the table is enough for Phase 2; charts can come later if useful).

## Constraints

- **No regression of Phase 1.** The CLI and daemon API contracts from Phase 1 are stable. Phase 2 only adds endpoints; it does not modify or remove any.
- **TypeScript conventions in `CLAUDE.md` are ground truth.** `.js` extensions on relative imports, `noUncheckedIndexedAccess`, etc.
- **No new server runtime dependencies beyond the SSE-capable framework already chosen in Phase 1 (Hono).** UI dependencies live under `web/` and don't bloat the server bundle.
- **CSP-friendly UI.** No `eval`, no inline `<script>` (except the framework boot tag from Vite), no `unsafe-inline` in styles. This makes adding auth in Phase 3 painless.
- **No analytics, telemetry, or external network calls from the UI.** Mill is a local-first tool; the UI only talks to its own daemon.
- **Performance:** initial paint of the dashboard with 5 projects and 100 runs total should be < 500ms over loopback. SSE messages should appear in the UI within 100ms of the SQLite INSERT.
- **Bundle size:** the UI bundle (gzipped) should be under 200KB. If it's creeping above, drop a dep before adding one.
- **Accessibility:** keyboard-navigable on all four screens; semantic HTML for tables and lists; color-blind-safe status indicators (icons + color, not color alone).
- **Crash recovery is unchanged.** The UI must not become a load-bearing component for run integrity. If the daemon stops, the UI shows a clear "daemon offline — run `mill daemon start`" banner; runs in flight are not affected.

## Open questions

These should be surfaced by the clarification stage:

1. **Single SSE endpoint with replay-then-live, or two endpoints (one for replay, one for live)?** Lean: single endpoint, with `Last-Event-ID` driving the replay window. Fewer concepts.
2. **Routing library:** TanStack Router, React Router, or hand-rolled? Lean: hand-rolled (4 routes) — but if the assistant prefers TanStack Router for type-safety, that's fine too.
3. **Dashboard refresh cadence:** background poll every 5s, or refresh-on-window-focus only? Lean: focus + manual refresh button. Live data lives on the run view.
4. **New-run requirement input:** plain textarea, or do we want a `--from <file>` analogue (paste a path, daemon reads from disk)? Lean: textarea only in Phase 2 — the daemon currently has no file-read endpoint and adding one is its own surface.
5. **Authentication-shaped affordances in Phase 2:** even without auth, should the UI display a "you" identity (read from `MILL_USER` env or git config) so audit log entries have someone attached? Lean: yes, single `actor` string from env, written into events; trivial and forward-compatible with Phase 3 auth.
6. **Real-time cost in run view:** live-update the cost rollup as `addStageCost` fires, or only on stage-end? Lean: live, since the emitter fires on every cost-event row anyway.
7. **What does the UI do when there are zero projects registered?** Lean: empty state with a button that runs `POST /projects` against cwd if cwd is a git repo (the daemon would need to know cwd of the *user*, which it doesn't — so probably just show a "register from CLI: `mill project add /path`" instruction).
8. **Activity feed verbosity:** mirror `mill tail` (default) or `mill tail -v` (full text + thinking + tool bodies)? Lean: default, with a toggle for verbose.
9. **Finding detail viewer:** render the markdown stored at `findings.detail_path` inline, or open in a separate tab? Lean: inline, in a side panel.

## References (files this will touch)

- `src/daemon/server.ts` (from Phase 1) — register SSE route, register static file middleware, register `/dashboard` aggregate endpoint.
- `src/daemon/sse.ts` (new) — SSE handler with `Last-Event-ID` replay-then-live logic.
- `src/core/store.sqlite.ts` — add the in-process `EventEmitter`; export a `subscribeToRunEvents(runId, listener)` helper.
- `src/cli.ts` — `mill daemon start --no-ui`, `--open`, mention UI URL on start.
- `src/orchestrator/progress.ts` — extract the formatter into a function the UI can also use (move to `src/core/progress.ts` if needed; or duplicate the small formatter on the UI side).
- New: `web/` directory containing the Vite project.
  - `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`.
  - `web/src/main.tsx`, `web/src/app.tsx`, `web/src/api/*.ts` (typed client over Phase 1 + new endpoints), `web/src/sse.ts` (EventSource wrapper).
  - `web/src/screens/dashboard.tsx`, `web/src/screens/project.tsx`, `web/src/screens/run.tsx`, `web/src/screens/findings.tsx`.
  - `web/src/components/*` for shared UI atoms (status badge, cost display, stage timeline, activity feed, finding card).
- `package.json` — add a top-level `web/` workspace or a `build:web` script; update `npm run build` to include it.
- `README.md` — UI section, dev workflow.
- `.env.example` — `MILL_DEV`, `MILL_USER`.
- `tsconfig.json` — exclude `web/` from the main TS project (it has its own).

The orchestrator (`pipeline.ts`, `stages/*`, `critics/*`) does not need any changes for Phase 2.
