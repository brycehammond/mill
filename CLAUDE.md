# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mill` is a Node/TypeScript harness that `spawn`s the `claude` CLI for each pipeline stage (spec → design → (spec2tests?) → implement ⇄ review → verify → deliver → decisions). The binary is `mill`. The harness does **not** call the Anthropic API directly — `claude` does. Our job is orchestration, sandboxing, budget/kill enforcement, and SQLite persistence. `README.md` has the user-facing tour; this file is for contributors.

## Multi-project model (Phase 1)

`mill` is now a host-level service rather than a per-repo tool. There are three pieces, with a sharp split:

1. **Central management state at `~/.mill/`.** One SQLite DB at `~/.mill/mill.db` holds `projects`, `runs`, `stages`, `events`, `findings`, etc. Per-project durable files (`journal.md`, `decisions.md`, `profile.json`, `stitch.json`) live at `~/.mill/projects/<project-id>/`. Override the root with `MILL_HOME=/path` for tests/CI.

2. **Per-repo workdirs at `<repo>/.mill/runs/<id>/...`.** Run artifacts (workdir, KILLED sentinel, verify/, reviews/, design/, requirement.md, spec.md, delivery.md) stay inside the project repo. **This is load-bearing**: Claude Code's CLAUDE.md auto-discovery walks up from cwd and the workdir is `<repo>/.mill/runs/<id>/workdir/` — moving it out of the repo would silently lose CLAUDE.md context, and edit-mode's `git worktree add` flow would also break. There is no `mill.db`, no journal, and no project marker inside the repo any more.

3. **Daemon process owns run execution.** `mill daemon start` brings up a Hono HTTP server bound to `127.0.0.1:7333` (configurable via `MILL_DAEMON_HOST`/`MILL_DAEMON_PORT`). The CLI is a thin client: mutating commands (`mill new`, `mill run`, `mill kill`, `mill project add/rm`, clarifications) talk to the daemon over HTTP. Read commands (`mill status`, `mill tail`, `mill logs`, `mill history`, `mill findings`, `mill project ls`) open the central DB read-only and bypass the daemon, so observation works when the daemon is down. **Single writer** — only the daemon mutates the central DB, which avoids `database is locked` races.

The orchestrator (`pipeline.ts`, `stages/*`, `critics/*`, retry, claude-cli, guard, run-settings, progress) is untouched by this restructure. Project-awareness lives in:

- `RunContext.projectId` and `RunContext.stateDir` — set by `buildContext({ runId, config, store })` from the run row's `project_id`. Stages that need cross-run memory pass `ctx.stateDir` to journal/decisions/profile/stitch readers (the readers no longer take `<repo>/.mill/`).
- `core/project.ts::addProject` — async; auto-runs `migrateLegacyMill` after a fresh registration so a user with an existing per-repo `.mill/mill.db` gets imported transparently.
- `core/migrate.ts` — legacy `<repo>/.mill/mill.db` → central import. Idempotent (writes a `.mill/migrated-to-central.json` marker), non-destructive (legacy DB renamed to `mill.db.legacy-<unix-ts>`, not deleted), state files copied with central-wins on conflict.
- `orchestrator/config.ts::loadConfig({ cwd?, projectIdentifier? })` — opens the central DB, resolves the project (from `--project <id|name|path>` or by walking up from cwd via `resolveProjectFromCwd`), returns `MillConfig` with `projectId`, `stateDir`, `root`, plus the global pieces. `loadGlobalConfig()` returns just the global pieces (used by the daemon entrypoint, which serves all projects).
- `daemon/server.ts` and `daemon/run-loop.ts` — HTTP routes and the cross-project run scheduler. `MILL_MAX_CONCURRENT_RUNS` (default 2) is the **global** cap across all projects; per-project caps via `projects.default_concurrency` are bounded by the global one (global wins).

`mill init` is kept as a deprecated alias for `mill project add`. The legacy `worker.ts` is still present but the daemon is the supported path.

## Web UI (Phase 2)

The same daemon process serves a React SPA at `http://<bind>/`. Four files own the new server-side surface:

- `src/core/event-bus.ts` — in-process `EventEmitter` published to from `store.sqlite.ts::appendEvent` *after* the INSERT lands. Subscribers (only SSE today) attach with `subscribeToRunEvents(runId, listener)`. SQLite remains the source of truth; the bus is a fanout, not a queue. If the bus drops a fire (it shouldn't), the next reconnect's `Last-Event-ID` replay re-reads the events table.
- `src/daemon/sse.ts` — `text/event-stream` handler at `/api/v1/runs/:id/events`. Replay-then-live: subscribes to the bus *before* paginating the SQL backlog so a row inserted mid-replay is queued, then drains the backlog, then dedups against in-flight queued frames by id. Frames carry `id:` (matching `events.id`) but **no `event:`** — `kind` lives in the JSON body so every frame routes through the client's `onmessage`. Slow consumers are dropped past `QUEUE_CAP` (1024); they reconnect via EventSource and replay from `Last-Event-ID`.
- `src/daemon/static.ts` — serves `dist/web/index.html` + `dist/web/assets/*` with SPA fallback. **Crucial:** the resolver walks for `dist/web/index.html` only, never bare `web/index.html`, because the dev source's index.html references `/src/main.tsx` which 404s without Vite. Disabled via `MILL_NO_UI=1` (`mill daemon start --no-ui`) and `MILL_DEV=1` (the dev workflow runs Vite separately).
- `src/daemon/server.ts` — Phase 1 unprefixed routes are unchanged (CLI client contract). New routes live under `/api/v1`: `runs/:id/events` (SSE), `dashboard` (cross-project rollup), `projects/:id/findings`, `findings/suppressed` GET/POST/DELETE. `BuildServerArgs.serveUi` defaults to true; `index.ts` reads `MILL_NO_UI` / `MILL_DEV` to flip it.

The UI itself lives at `web/` as a separate package (not a workspace — its deps don't bloat the server bundle). Stack: React 18 + Vite + Tailwind + TanStack Query + a hand-rolled router (four routes — TanStack Router would be more dependency than the spec allows). `npm run build` at the repo root chains `tsc -p .` then `npm run build:web`, which `cd web && npm install --no-fund --no-audit && npm run build` and emits to `../dist/web/`. Bundle target: < 200KB gzipped (currently 65KB).

Dev workflow: `MILL_DEV=1 mill daemon start --foreground` (UI off) + `cd web && npm run dev` (Vite at :5173 with HMR, proxying `/api`, `/healthz`, `/projects`, `/runs`, `/findings` to the daemon).

## Phase 3 (auth, bind, budget, approvals, webhooks)

Phase 3 makes mill safe to expose beyond a single user's laptop. Phase 1–2 contract is preserved verbatim — set nothing and the daemon still binds loopback with no auth. The pieces below activate when their respective env vars / DB rows are populated.

- **Auth lives in `src/daemon/auth.ts`.** `MILL_AUTH_TOKEN` (or the contents of `~/.mill/auth.token` written by `mill auth init`) gates `/api/v1/*` via a Hono middleware. Bypass list: `/api/v1/auth/session*` and `/api/v1/health`. Comparison is `crypto.timingSafeEqual` over equal-length buffers (length mismatch → constant-time false). UI sessions are DB-backed (`auth_sessions` table — **not** `sessions`, which was already taken by per-stage claude-session storage); cookie name is `mill_session`, attributes `HttpOnly + SameSite=Strict + Path=/ + Max-Age=lifetime`, plus `Secure` unless the daemon was started with `BuildServerArgs.insecureCookies` (set when bind has no TLS, so cookies still work over plain HTTP through a TLS-terminating proxy). `getActor(c)` is the canonical helper for "who did this" — call it for every user-driven `appendEvent`. `mill auth rotate` calls `deleteAllAuthSessions()` directly on the central DB so a rotation forces re-login everywhere (Q1 lean).

- **Bind lives in `src/daemon/bind.ts`.** `--bind <loopback|lan|all>` plus `--insecure` and `--cert/--key`. `validateBind` refuses non-loopback without `MILL_AUTH_TOKEN` and without either TLS or `--insecure` (the latter is "I'm behind a TLS-terminating proxy"). LAN IP comes from `os.networkInterfaces()` filtered to non-internal IPv4. TLS goes through `node:https.createServer` via `@hono/node-server`'s `createServer` option.

- **Pipeline state machine has three peer error classes:** `KilledError` (existing, hard interrupt), `BudgetPausedError` (graceful, resumable), `ApprovalRequiredError` (graceful, resumable). All three unwind via `enforceBetweenStages` (renamed from `throwIfKilledOrBroken`) at stage boundaries — never mid-stage. The catch block in `pipeline.ts` discriminates on `instanceof` and leaves the run row in its paused state instead of flipping to `failed`. Adding a fourth class follows the same pattern.

- **Budget lives in `src/daemon/budget.ts`.** Calendar month UTC (`Date.UTC(...)`), no timezone surprises. `checkPreflight` returns `{ok: false, status: 402}` on overage; `checkInflight` is called from `claude-cli.ts` after each `addStageCost` (kept out of the store layer to avoid daemon→core→daemon cycles). 80%-warning idempotency is enforced by querying `events` for an existing `budget_warning_80` in the current month before emitting. The threshold re-arms when the month rolls over because the query is month-scoped.

- **Webhook delivery lives in `src/daemon/notify.ts`.** It's an in-process queue subscribing to the global event bus on daemon startup (same pattern as `src/daemon/sse.ts` — both fanout from `appendEvent`). The bus uses snake_case kinds (`budget_warning_80`, `approval_required`, …); the wire payload uses dot-notation (`budget.warning_80`, `approval.required`, …). Mapping is in notify.ts and is the only place the two naming conventions touch — keep it that way. Best-effort: 5s timeout per attempt, 3 retries with 1s/5s/30s backoff, auto-disable after 10 consecutive failures (writes a `webhook_disabled` event via `appendEvent` directly — don't recurse into notify). Webhook secrets are required at creation time (Q6) and never returned in API responses (`secret_set: true` instead).

- **Actors and audit trail.** `events.actor` is `'mill'` for stage-emitted events, the authenticated session's actor for UI actions, and `MILL_USER` (or git's `user.email`) for CLI mutations. `appendEvent(runId, stage, kind, payload, actor?)` — actor is the 5th, optional argument; default is `'mill'`. New stage-call sites should NOT pass it; new user-action sites MUST.

- **New schema** (additive only — Phase 1–2 DBs upgrade in place): `events.actor TEXT NOT NULL DEFAULT 'mill'` (existing rows backfill via SQLite's default), `runs.awaiting_approval_at_stage TEXT NULL`, `runs.failure_reason TEXT NULL` (canonical: `"rejected" | "budget" | "error"`), `auth_sessions`, `project_approval_gates` ((project_id, stage_name) PK with FK CASCADE), `project_webhooks`. Foundation also exposed `Phase3EventKind` in `core/types.ts` as the canonical name list — add new event kinds there.

- **Crash recovery.** Runs in `paused_budget` or `awaiting_approval` survive daemon restart (the row IS the state — SQLite gives this for free). The pipeline driver does NOT auto-resume them: explicit user action (`mill approve / resume / reject`, the UI buttons) or a budget rollover plus user-initiated resume is required.

- **Gotchas.**
  - `MILL_AUTH_TOKEN` does NOT affect outbound webhooks — that's a separate HMAC secret per webhook row.
  - Login endpoint returns 400 (not 401) when auth is unconfigured so the SPA can detect "no auth" without false positives.
  - `removeProject` is a soft delete — webhook and gate rows survive a soft-removed project. The FK CASCADE only fires on hard delete (use `hardDeleteProjectForTest` in tests).
  - Webhook delivery uses snake_case event kinds at the bus layer (matching the store) and dot-notation in the wire payload. UI consumers see whichever the API surfaces (snake on event rows; dot on incoming webhook bodies).

## Commands

```sh
npm run mill -- daemon start   # bind 127.0.0.1:7333; pidfile at ~/.mill/daemon.pid
npm run mill -- daemon stop    # SIGTERM, drains in-flight runs
npm run mill -- daemon status

npm run mill -- project add    # register cwd; idempotent; auto-imports legacy .mill/mill.db
npm run mill -- project ls
npm run mill -- project show <id>
npm run mill -- project rm <id>

npm run mill -- new "..."      # start a new run (prompts for clarifications inline)
npm run mill -- run <run-id>   # resume a partially-completed run
npm run mill -- status [id]    # inspect state (works without daemon)
npm run mill -- tail <id>      # human-readable activity stream
npm run mill -- logs <id>      # raw events
npm run mill -- kill <id>      # writes .mill/runs/<id>/KILLED sentinel
npm run mill -- onboard        # one-shot repo profile → ~/.mill/projects/<id>/profile.json
npm run mill -- findings       # recurring findings across runs (ledger)
npm run mill -- history        # print this project's journal
npm run daemon                 # tsx src/daemon/index.ts — same as `mill daemon start --foreground`
npm run worker                 # legacy single-project poll loop (deprecated; use daemon)

npm run typecheck              # tsc --noEmit
npm test                       # node test runner via tsx (src/**/*.test.ts)
npm run build                  # tsc + cp prompts + npm run build:web (clean first!)
npm run build:web              # cd web && npm install + vite build → dist/web/
npm run clean                  # rm -rf dist
```

The `build` target's `cp -r src/prompts dist/prompts` fails if `dist/prompts` already exists (macOS cp copies *into* rather than replacing). Always `npm run clean && npm run build` for a full build.

`npm test` runs Node's built-in test runner under `tsx` with no extra deps. Coverage is intentionally pure-function-shaped — the harness `spawn`s `claude`, so end-to-end tests would require live API calls. Today's suites: `core/costs.test.ts` (cost tally), `core/types.test.ts` (severity ordering, finding fingerprint), `core/store.sqlite.test.ts` (SQLite round-trip via `:memory:`, projects CRUD), `core/project.test.ts` (`addProject` idempotency, cwd-walk resolution), `core/migrate.test.ts` (legacy `.mill/mill.db` import + state-file copy), `orchestrator/claude-cli.test.ts` (JSON / markdown extractors and `pickStructured`), `orchestrator/stages/review.test.ts` (`shouldStopReviewLoop`), `daemon/server.test.ts` (HTTP routes via `app.fetch`), `daemon/run-loop.test.ts` (cross-project scheduler caps + drain), `cli/client.test.ts` (HTTP client + `DaemonNotRunningError`). When you add a new pure helper or load-bearing invariant, add a test next to it (`*.test.ts` colocated).

## Import extension rule

`tsconfig.json` uses `"module": "ESNext"` with `"moduleResolution": "Bundler"`, and we ship ESM. **Every relative import of a `.ts` file must be written with a `.js` extension** (e.g. `import { ... } from "../core/index.js"`). `tsx` resolves this in dev; `tsc` emits `.js` in `dist/`. Do not add new imports without the `.js` suffix — it will break the compiled build even if it "works" under `tsx`.

`noUncheckedIndexedAccess` is on. Non-null assertions like `names[i]!` after a parallel `settled.forEach(...)` are intentional; don't "fix" them by guarding, because the loop index is a bounded parallel array.

## Pipeline execution model

`src/orchestrator/pipeline.ts` is the driver. Four properties are load-bearing:

1. **Crash recovery is stage-idempotent.** `needsStage(ctx, name)` checks `store.getStage(...).status === "completed"` and skips. The CLI can invoke `mill run <id>` at any point and the pipeline picks up where it left off. New stages must persist completion through `store.finishStage(...)` or they will rerun forever on resume.

2. **Cost, usage, and session id are persisted incrementally by `runClaude`.** As `result` events stream in, `claude-cli.ts` deltas `addRunCost` / `addStageCost` / `addRunUsage` / `addStageUsage` and calls `saveSession` / `setStageSession`. This means a SIGTERM (timeout, kill) leaves the stage/run rows billed and resumable — the fix for a bug where a 10-min timeout on implement silently dropped ~$0.70 of real spend. Stage callers only call `finishStage(status, artifact_path, error)` — no cost math. If you add a new stage, follow the same pattern (no `addRunCost` / `saveSession` in callers). Callers that run multiple subprocesses under one stage (critics, team-lead) pass a unique `sessionSlot` so each can resume. Note: the per-stage budget check fires after streaming settles, so an over-budget stage fails fast even though the cost is already in the DB.

3. **Kill is checked in two places.** The `KILLED` sentinel file is checked (a) by the `PreToolUse` guard hook on every tool call inside `claude`, and (b) by `throwIfKilledOrBroken` after each stage in the pipeline. Both checks must remain; the hook blocks in-flight tool use, the pipeline check unwinds the stack cleanly via `KilledError`.

4. **Post-deliver stages are best-effort.** `decisions` runs after `deliver`, which has already set the run to `completed|failed`. A failure inside `decisions` must *not* flip that outcome — it catches its own errors, writes a stage row so resume doesn't loop, and returns `ok: true`. Any future post-deliver stage must follow the same pattern.

## Review loop termination

`shouldStopReviewLoop` in `stages/review.ts` stops on any of: max iterations, zero HIGH+ findings, or current HIGH findings are a subset of the previous iteration's (the "stuck" signal). Subset test uses `findingFingerprint(f) = critic|severity|title.toLowerCase()` — the canonical fingerprint is defined in `core/types.ts` and shared by stuck-detection, the cross-run ledger, and the suppression list. If you add critic fields that affect dedup, update it there (and migrate existing rows).

Critics run via `Promise.allSettled` — one critic crashing does not kill the review; it's logged and the stage is marked failed while still producing a findings report. There are five critics, not all LLM-backed:

- `security`, `correctness`, `ux` — Claude, read-only (`Read`/`Glob`/`Grep`/`Bash`), routed through `critics/shared.ts::runCritic`.
- `tests` — **mechanical**. Runs `.mill/profile.json`'s test command as a subprocess; non-zero exit → HIGH finding. Auto-off if the profile lacks a test command. Same `CriticResult` contract so `review.ts` aggregates it uniformly.
- `adversarial` — optional, gated on `MILL_ADVERSARIAL_REVIEW=auto|on|off` plus both the Codex plugin and the `codex` CLI being available. Billing is on the codex side and usage is reported as zero in `TokenUsage`.

### Team-mode review (MILL_AGENT_TEAMS)

The three LLM critics (`security`, `correctness`, `ux`) have a second execution path: one `claude` subprocess plays "review lead" and spawns each critic as a *parallel Agent subagent* in a single session. `critics/team-review.ts` drives this; `prompts/review-lead.md` is the lead persona; `prompts/critic-*.md` are pushed into the session as custom subagents via the `--agents <json>` CLI flag (the JSON rejects `tools` as a comma-string — must be an array).

These are **not** Claude Code agent teams. Earlier attempts used `TeamCreate` + `Agent(team_name=...)` + `SendMessage` so critics could cross-reference each other's findings. That interacts badly with `--json-schema`: teammate replies arrive as new conversation turns on the lead, and the schema must be satisfied at the end of *every* turn — including the first one (which ends right after the team is spawned, before any critic has replied). The lead had no choice but to emit structured output with empty ERROR stubs on its first turn, then the subprocess stayed alive for minutes processing idle/shutdown traffic. Parallel Agent calls sidestep this: each Agent call is synchronous to the lead (subagent runs to completion, returns final text), and the lead emits structured output only once, after all three replies are in hand.

`MILL_AGENT_TEAMS=auto|on|off` picks the path. `auto` (default) tries team mode and quietly falls back to `Promise.allSettled([securityCritic, correctnessCritic, uxCritic])` on any failure. `on` hard-fails the review stage if team mode errors. `off` skips team mode entirely. `tests` and `adversarial` never go through the team-mode path — `tests` is mechanical and `adversarial` is codex-backed.

Two capability trade-offs to know about:
1. **Session slots collapse.** Per-subprocess mode persists `review:security`, `review:correctness`, `review:ux` so each critic resumes iteration-to-iteration. Team mode persists a single `review:lead` slot; the lead carries prior-iteration context and re-briefs fresh critics each time. Keep this in mind if you add a new slot key — don't assume per-critic resume exists in team mode.
2. **Per-critic cost attribution is lost.** The lead subprocess emits one `total_cost_usd` covering itself + the three critics. Run-level cost is still correct; per-critic cost reporting (tail/status) shows it all under the lead session. Document any new per-critic cost metric as "subprocess-path-only."

There's also a **post-result grace timer** in `claude-cli.ts` (`POST_RESULT_GRACE_MS`) that force-kills the subprocess 20s after it emits a result with non-null `structured_output`. This is a belt-and-suspenders guard: normally the subprocess exits in <1s after its final result, but in team-adjacent flows it sometimes outlives `child.on("close")`. The timer only arms once the final schema-satisfying payload has been seen, so it will not interrupt long-thinking turns that haven't produced structured output yet.

## Structured output from `claude`

Stages that need JSON pass a `jsonSchema` (zod → `zod-to-json-schema`) to `runClaude`. Read the result with `pickStructured(result)`, not `JSON.parse(result.text)`. `pickStructured` prefers `result.structuredOutput` (the parser built into Claude Code), falls back to `extractJsonBlock`, and surfaces non-success subtypes (`error_max_turns`, `error_during_execution`, `error_budget`) as errors instead of masking them as parse failures.

## Stage retry-with-hint

`orchestrator/retry.ts::runWithRetry` gives stages one bounded retry on recoverable validation failures. Pattern: caller passes an `attempt(hint)` closure that builds the `runClaude` call (appending the hint to the user prompt when present), plus a `validate(res) => string | null` that returns a hint string on bad output or `null` when fine. On first-try validation failure, the helper retries once with the hint, rolls both attempts' cost/usage into the returned result, and emits a `remediation` event row (`mill tail` and `mill logs` surface it). Two retries is the cap — repeated failure with the same hint means the hint isn't landing and more attempts waste budget. Today wired into `stages/spec.ts` and `stages/design.arch.ts` for the "markdown output under 50 chars" case; extend to other stages when you identify a recoverable class (parse errors with a clear "your output was X, should be Y" diagnosis). Do not wrap calls where the failure mode is fatal (kill sentinel, budget exceeded, subprocess crash) — those must propagate. Remediation events are not written to `.mill/journal.md`; that file is one-stanza-per-completed-run and its tail feeds future prompts, so we don't want retry noise there.

## Per-run sandbox

`run-settings.ts` writes `<repo>/.mill/runs/<id>/workdir/.claude/settings.json` with a `PreToolUse` hook pointing at `guard.ts` (dev: `tsx guard.ts`; prod: `node guard.js`, toggled by `isSourceMode`). Two things about this are easy to miss:

- Claude Code's `--setting-sources project` reads `.claude/settings.json` from **cwd only**, not walking up. The file must live in the workdir, not in a parent. (Verified against claude 2.1.117 on 2026-04-22.)
- `guard.ts` runs **on every tool call** of every `claude` subprocess. Keep it dependency-free — no imports from `src/core/`. It reads state from env vars (`MILL_RUN_KILLED`, `MILL_WORKDIR`, `MILL_EXTRA_WRITE_DIRS`, `MILL_RUN_ID`) set by `claude-cli.ts`. It must fail open on parse/IO errors so a bug in the hook can't brick Claude Code itself.

Stages that legitimately write outside the workdir (e.g. verify writes into `<repo>/.mill/runs/<id>/verify/`) declare those paths via `extraWriteDirs`, which becomes `MILL_EXTRA_WRITE_DIRS` (colon-separated).

### Two layers of command restriction

Destructive-command blocking (`sudo`, `rm -rf /`, fork bomb) lives **only** in `permissions.deny` inside the per-run `settings.json` — not in `guard.ts`. The guard used to duplicate these with regex, but the sudo word-boundary pattern produced false positives (e.g. `echo "use sudo"` would get blocked). Keep the guard focused on state-dependent checks (`KILLED` sentinel, dynamic write-dir allow-list) that settings can't express, and add new static command bans to `run-settings.ts::permissions.deny` only.

## User-level skills and hooks

In-run `claude` subprocesses default to `--setting-sources user,project` via `defaultSettingSources()` in `orchestrator/config.ts`, so the user's installed skills (e.g. a `commit` skill that suppresses the `Co-Authored-By: Claude` trailer), output styles, status line, and global hooks (`Stop`, `PostToolUse`, `UserPromptSubmit`, etc.) all fire inside mill stages just like a normal Claude Code session would. That includes hooks that talk to Slack/webhooks — by default those are user-trusted infrastructure. Set `MILL_USER_HOOKS=off` to revert to project-only isolation when you don't want that (CI, shared workers, anywhere user hooks would be inappropriate).

Earlier versions hardcoded `settingSources: ["project"]` and added `inheritUserMcps: true` to selectively pull in user-level MCPs (Stitch, Playwright) without their hooks. That MCPs-without-hooks path still exists on `runClaude` for callers that explicitly want it, and `MILL_USER_MCP_CONFIG` still overrides which file is read. With `MILL_USER_HOOKS=on` (default), no caller needs to opt in — user MCPs arrive via `--setting-sources user` along with everything else.

Critics use `--system-prompt` (replace mode), so user-level system-prompt customizations don't override the critic persona, but user skills/hooks still fire. If a user hook materially changes critic behavior (e.g. a `Stop` hook that posts findings to Slack mid-review), turn `MILL_USER_HOOKS=off` for that run.

## Session slots

Each stage persists a `session_id` via `store.saveSession(runId, slot, ...)`. Slots are logical strings: stage names (`implement`, `verify`, `decisions`) and sub-keys for critics (`review:security`, `review:ux`, etc.). The implementer resumes across review iterations with `--resume <implement-session-id>` so it keeps context. Critics each resume their own session so their prior reasoning carries forward iteration to iteration.

## Cross-run memory

Per-project files under `~/.mill/projects/<project-id>/` accumulate state that future runs auto-inject into their prompts. When adding a new stage that takes spec/design as input, match the existing pattern: read these (via `readJournalTail`, `readDecisionsTail`, `renderLedgerHint`) — passing `ctx.stateDir`, NOT `ctx.root` — and prepend to the prompt body.

- **`journal.md`** — one stanza per completed run. Written by `stages/deliver.ts` via `appendJournalEntry(ctx.stateDir, ...)`. Entries are `\n---\n`-delimited. A write failure is caught and logged but does not fail the run.
- **`decisions.md`** — ADR-lite trade-off log. Written by `stages/decisions.ts` post-deliver via `appendDecisionEntries(ctx.stateDir, ...)`, strictly gated (must cite a finding fingerprint, spec criterion, or external constraint — zero entries is the common case). Same delimiter convention.
- **findings ledger** — aggregated from the `findings` SQLite table at `~/.mill/mill.db` via `store.listLedgerEntries(...)` and rendered by `core/ledger.ts::renderLedgerHint`. Edit-mode only — surfaces recurring issues so the implementer preempts them.
- **`profile.json`** — repo profile written by `mill onboard` (`orchestrator/onboard.ts`). Not per-run; refresh with `mill onboard --refresh`. Rendered into prompts via `readProfileSummary(ctx.stateDir)`.
- **`stitch.json`** — Stitch project reference (URL + lastRunId + updatedAt) written by `stages/design.ui.ts` via `writeStitchRef(ctx.stateDir, ...)` after a successful UI design. Edit-mode design runs that find this file load `prompts/design-ui-edit.md` instead of `prompts/design-ui.md` and get `mcp__stitch__get_project` + `mcp__stitch__list_projects` added to their allowedTools so they can confirm the URL is still live and reuse it via `edit_screens` instead of `create_project`. Stale-URL recovery is the model's job — the edit prompt instructs it to fall back to `create_project` if `get_project` returns not-found, and the new URL is written here on success. Helpers: `readStitchRef` / `writeStitchRef` in `core/stitch.ts`.

The state-file readers (`journal.ts`, `decisions.ts`, `profile.ts`, `stitch.ts`) take a `stateDir: string` directly — they do not know about `<repo>/.mill/` any more. The path resolver `paths.ts::projectStateDir(projectId)` is the canonical way to get a state dir from a project id. CLI commands resolve via `loadConfig()`, the daemon resolves per-request from the run row's `project_id`.

### CLAUDE.md is loaded by claude, not by mill

Claude Code auto-discovers `CLAUDE.md` from cwd upward (verified: finds project-root `CLAUDE.md` even from deep workdirs like `.mill/runs/<id>/workdir/`). **mill must not inject CLAUDE.md content into the user prompt** — it would be double-exposed to the model. Instead, the stage prompts (`spec.md`, `design-arch.md`, `implement.md`, the three LLM critics, `onboard.md`) explicitly tell the model "treat CLAUDE.md as ground truth; any mill block that disagrees with it loses." If you add a new stage prompt that cares about repo conventions, follow the same pattern: *reference* CLAUDE.md, don't read or inject it.

This holds for both `--append-system-prompt` and `--system-prompt` (replace mode used by critics). Only `--bare` disables CLAUDE.md auto-discovery; mill never uses that flag.

## Prompts

`src/prompts/*.md` are the stage + critic system prompts. `npm run build` copies them into `dist/prompts/`. They are loaded at runtime, not bundled — you can iterate on prompt wording without a rebuild in dev (`tsx` reads from `src/prompts/`). Don't inline prompt text into `.ts` files. Note: edit-mode has its own variants (`spec-edit.md`, `design-arch-edit.md`); `stages/spec.ts` picks the prompt by `ctx.mode`.

### append vs replace system prompt

`runClaude({ systemPrompt, systemPromptMode })` controls whether the stage prompt is appended to Claude Code's default system prompt (`append`, default — keeps tool-use guidance) or replaces it entirely (`replace`, for narrow roles like critics). Critics use `replace` so the default coder framing (nudges toward `TodoWrite`, writing tests, fixing code) doesn't leak into a review task. If you add a new stage with a scoped role and a self-contained prompt, `replace` is the right call; otherwise stick with `append`.

## Stage timeouts

`MILL_TIMEOUT_SEC_PER_STAGE` (default 600s) is the global fallback. Specific stages override via their own vars: `MILL_TIMEOUT_SEC_IMPLEMENT` defaults to 7200s (2h), `MILL_TIMEOUT_SEC_VERIFY` defaults to 1800s (30m). Implement got the long budget because a from-scratch TDD build on a real app is 100+ tool calls. `MILL_TIMEOUT_SEC_PER_RUN` (default 14400s / 4h) caps the whole pipeline. Overrides live on `ctx.stageTimeoutsMs[stage]`; `runClaude` picks the first of: caller override → stage-specific → `ctx.stageTimeoutMs`. The implement prompt surfaces the stage's wall-clock budget so the model can pace itself and commit one-AC-per-commit before getting SIGTERM'd.

## TDD workflow (spec2tests + implement)

The pipeline is test-driven end-to-end:

- **`spec` writes numbered acceptance criteria.** `prompts/spec.md` demands testable bullets; verify is told to run them. If a criterion can't be verified, it goes in the open-questions list.
- **`spec2tests` runs between design and implement in both new and edit mode.** In edit mode it reuses `profile.commands.test`; in new mode it bootstraps a framework matching the spec's tech choices (Vitest for Node, pytest for Python, `swift test`, `cargo test`, etc.), writes failing tests tagged `[AC-<N>]`, and commits the scaffold. Output schema requires `test_command: string` — the stage persists it to `runs.test_command` via `updateRun` so downstream stages don't need to re-discover it. The stage is ungated on profile presence (gated only by `MILL_SPEC2TESTS=auto|on|off`; default on).
- **`implement` receives the test command in its prompt** and is told to work AC-by-AC in a red → green → refactor → commit cadence. `stages/implement.ts::buildPrompt` resolves the command via `resolveTestCommand({ root, runTestCommand: run.test_command })` — same resolver the tests critic uses. The implement prompt also discourages adding untested production code.
- **`tests` critic** (mechanical, in `critics/tests.ts`) runs the resolved test command each review iteration and emits a HIGH finding on non-zero exit. Previously profile-gated; now uses `resolveTestCommand` so it fires in new-mode runs too. `review.ts` gates critic registration on the same resolver.

The resolver's priority is **`run.test_command` first, then `profile.commands.test`**. This means an edit-mode run can still override the project profile with a run-specific command (e.g. running just the test file relevant to the change) — spec2tests simply writes its decision there. If neither is set, the tests critic skips and the implement prompt tells the model it has to configure a runner itself.

When adding new stages that need to run tests, use `resolveTestCommand`; do not re-read the profile directly.

## New-mode workdir promotion and branch import

Edit-mode runs commit onto a fresh `mill/<slug>-<shortId>` branch via `git worktree add` (in `stages/intake.ts`). The slug is derived from the requirement text via `slugifyRequirement` (`core/slug.ts`) — biographical preambles ("I am a…", "As a…") are skipped in favor of the next sentence; stop words filtered; truncated to 40 chars at a word boundary. The 4-char shortId (last 4 chars of the run id) keeps two runs with similar intents from colliding. Falls back to `mill/run-<runId>` only when the requirement degenerates to all stop words. Result: branches show up in `git branch -a` as `mill/add-dark-mode-toggle-settings-page-sa2n` instead of `mill/run-20260424-140852-sa2n`. New-mode runs build into `<repo>/.mill/runs/<id>/workdir/` with a self-contained git history — useful for sandboxing and parallel runs, but the result is invisible to anyone looking at the project root.

After a clean delivery (verify pass + zero unresolved HIGH+), `deliver.ts` does two things, both best-effort:

1. **`promoteWorkdir`** (`orchestrator/promote.ts`) copies the workdir contents up into `ctx.root` for new-mode runs. Two non-obvious rules: (1) `.git/` is skipped — copying it would destroy the parent's repo. The workdir's git history stays accessible at `<repo>/.mill/runs/<id>/workdir/.git/` for users who want to cherry-pick it. (2) `.gitignore` is *merged*, not overwritten — the workdir's language-specific rules (`.build/`, `.swiftpm/`, …) are preserved alongside the `/.mill/` rule that `mill project add` lays down. `MILL_PROMOTE_NEW_WORKDIR=auto|on|off` gates: `auto` skips when the parent root has user content beyond `{.git, .gitignore, .mill}` (don't silently overwrite); `on` always promotes; `off` never.

2. **`importWorkdirBranchToParent`** (same file) makes the workdir's branch reachable from the parent repo's `.git`, for **both** modes. Edit-mode is a short-circuit no-op via `gitBranchExists` (the worktree shares refs, and `git fetch` would refuse anyway because the branch is checked out in the linked worktree). New-mode runs `git fetch --update-head-ok <workdir> +<branch>:refs/heads/<branch>` from the parent root, init'ing `.git` first if needed. `--update-head-ok` is required because `gitInit` lands HEAD on `main` (unborn) and the workdir's branch is also `main` by default — without the flag git refuses to fetch into a checked-out ref. If the parent had no commits before the import (`gitHasHead === false`), the importer also `git symbolic-ref HEAD` + `git reset --hard <branch>` so the working tree matches the imported tip. Outcomes ("ref-only", "checkout", "skip-…") are surfaced in the delivery report and as `branch_imported` / `branch_import_skipped` / `branch_import_failed` events. Failures are logged but never fail the run.

There is no auto-PR creation. Earlier versions of mill had `--pr` to push the branch to `origin` and `gh pr create`; that was removed because the branch import makes the result reachable locally without round-tripping through GitHub. If you need a PR, the delivery report shows the branch and `git -C <root> ...` review/switch/merge commands.

## Environment knobs

All config is env-driven via `orchestrator/config.ts`. Defaults live there. `.env.example` documents them. `MILL_HOME` controls the central state root (`~/.mill/` by default — DB, per-project state, daemon pidfile/portfile all live there); set it for tests or CI that need an isolated tree. `MILL_DAEMON_HOST` (`127.0.0.1`) and `MILL_DAEMON_PORT` (`7333`) are the daemon's loopback bind — also read by the CLI client to find a running daemon. `MILL_MAX_CONCURRENT_RUNS` (default 2) is the daemon's global cap across all projects (a per-project cap via `projects.default_concurrency` is bounded by this). Other sub-stage gates: `MILL_ADVERSARIAL_REVIEW`, `MILL_TESTS_CRITIC`, `MILL_SPEC2TESTS`, `MILL_AGENT_TEAMS` — all accept `auto|on|off`, where `on` turns a missing dependency (or in the teams case, a failure) into a hard failure rather than a skip/fallback. `MILL_PROMOTE_NEW_WORKDIR=auto|on|off` gates new-mode workdir promotion (see above). `MILL_USER_HOOKS=on|off` (default `on`) controls whether in-run `claude` subprocesses load user-level skills, hooks, and MCPs via `--setting-sources user`. `MILL_USER_MCP_CONFIG` overrides the paths mill reads MCPs from when a caller explicitly opts into the `inheritUserMcps` MCPs-without-hooks path, collapsing the default two-file load to the single file specified. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are scrubbed from the `claude` subprocess env so a key in the parent shell can't silently flip billing to API mode.
