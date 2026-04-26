# Multi-project mill — Phase 3: production readiness

Make mill safe to expose beyond a single user's laptop: authentication, non-loopback bind, approval gates between stages, per-project budget enforcement, and outbound notifications. After this phase, mill is deployable as a small team service — one host running the daemon, multiple humans driving runs across many projects from any device on the network. Multi-tenancy, scheduling, and a plugin model remain out of scope and would be Phase 4+.

## Prerequisites

This requires both Phase 1 (`plans/multi-project-mill.md`) and Phase 2 (`plans/multi-project-mill-phase-2.md`) to be delivered:
- Central `~/.mill/` state, projects, daemon, HTTP API.
- Web UI with dashboard, project view, run view, findings ledger, SSE event stream.

If those aren't present, the spec stage should fail-fast and surface this as a blocker rather than rebuild Phases 1–2 inside Phase 3.

## Problem

Phases 1–2 produced a daemon and UI bound to loopback with no auth — fine for a single user on their own machine, not safe to expose anywhere else. Three concrete gaps prevent broader use:

1. **No access control.** Anyone with network reach to the daemon port can drive runs and spend money via the user's `claude` subscription. Loopback was the only mitigation.
2. **No budget hard stops.** `runs.total_cost_usd` accumulates and the per-stage budget check exists, but there's nothing to stop a project from burning through $X/month if a run loop misbehaves. Phase 1 stored `projects.monthly_budget_usd`; Phase 3 enforces it.
3. **No approval gates.** A misaligned spec turns into a fully-implemented misaligned feature without a chance for human review. Mill has natural seams (between design and implement, between implement and verify) that should be configurable as approval boundaries — both for spend control and for "I want a human to look at the design before I burn 90 minutes implementing it."
4. **No outbound notifications.** Runs that finish in the middle of the night, HIGH findings that emerge mid-iteration — there's no way to know without leaving the UI open. Webhook delivery is the minimum viable signal.

## Goal

After this phase, the daemon supports a Bearer-token auth scheme, refuses to bind non-loopback without auth configured, enforces per-project monthly budget caps with graceful pause-at-stage-boundary semantics, supports per-project "require approval before stage X" gates with a UI flow to release them, and emits webhook notifications on a configurable set of events (run completion, run failure, HIGH findings).

## In scope (Phase 3)

1. **Bearer-token authentication.**
   - New env var `MILL_AUTH_TOKEN`. If set, every API request (except `GET /api/v1/health`) requires `Authorization: Bearer <token>` matching that value. Constant-time comparison.
   - New CLI: `mill auth init` generates a strong random token, writes it to `~/.mill/auth.token` (mode 0600), and prints the value once. The user is expected to `export MILL_AUTH_TOKEN="$(cat ~/.mill/auth.token)"` in their shell rc.
   - New CLI: `mill auth show` prints the token (subject to 0600 perms on the file). `mill auth rotate` generates a new one and overwrites.
   - The CLI client picks up `MILL_AUTH_TOKEN` from env automatically and includes it on every daemon request.
   - The web UI has a one-time login screen that POSTs the token to `POST /api/v1/auth/session`, which validates it and sets an `HttpOnly` `Secure` `SameSite=Strict` cookie containing a session id (DB-backed in a new `sessions` table). UI requests use the cookie; the API still accepts `Authorization: Bearer` for CLI / programmatic clients.
   - Logout: `POST /api/v1/auth/session/delete` clears the session row and the cookie.
   - Auth is **all-or-nothing** in Phase 3: either auth is required for all requests (when token is set) or none (when unset). No public read endpoints, no scoped tokens.

2. **Bind configuration.**
   - New CLI flag: `mill daemon start --bind <loopback|lan|all>`. Defaults to `loopback` (127.0.0.1, today's behavior).
   - `lan` resolves to the host's primary LAN IPv4 address; `all` is `0.0.0.0`.
   - Refuse to start with `--bind lan` or `--bind all` if `MILL_AUTH_TOKEN` is unset. Print a clear error directing the user to `mill auth init`.
   - When binding non-loopback, the daemon also requires HTTPS or an explicit `--insecure` opt-in. HTTPS support: accept `--cert <path> --key <path>` to bind TLS. If unset, suggest using a reverse proxy (Caddy, nginx, Cloudflare Tunnel) and document that path; do not embed certificate provisioning.

3. **Per-project budget enforcement.**
   - `projects.monthly_budget_usd` from Phase 1 becomes load-bearing. Computation: sum of `runs.total_cost_usd` for that project where the run was created in the current calendar month (UTC).
   - Pre-flight check at intake (`POST /projects/:id/runs`): if creating the run is impossible (current monthly spend > budget), reject with HTTP 402 and a clear message.
   - In-flight enforcement: extend `addStageCost` (in `core/store.sqlite.ts`) to compute current monthly spend after the increment. If it crosses `monthly_budget_usd`, set `runs.status = 'paused_budget'` and write a `budget_exceeded` event. The pipeline driver checks for `paused_budget` between stages (alongside the existing `KILLED` check) and unwinds cleanly via a new `BudgetPausedError`. The next stage does not start.
   - Resume: `POST /api/v1/runs/:id/resume` restarts the pipeline if the project is now under budget (e.g. user raised the cap or a new month started). Otherwise returns 402.
   - Soft warnings at 80% of budget: the daemon writes a `budget_warning_80` event; the UI dashboard shows a yellow chip on the project card.

4. **Approval gates.**
   - New table `project_approval_gates`: `(project_id, stage_name)` pairs. A row means "pause runs in this project after the named stage completes; require explicit approval to continue."
   - CLI: `mill project gates set <project> <stage,stage,...>` and `mill project gates clear <project>`.
   - Pipeline driver: after each stage completes, check whether the next stage is gated. If yes, set `runs.status = 'awaiting_approval'`, persist `runs.awaiting_approval_at_stage = <next_stage>`, and unwind via `ApprovalRequiredError`. The run row remains resumable.
   - `POST /api/v1/runs/:id/approve` (with optional `note` body) clears the awaiting state, writes an `approval_granted` event including the actor (from auth session), and re-enqueues the run.
   - `POST /api/v1/runs/:id/reject` (with required `note` body) marks the run as `failed` with reason `rejected`. The run can still be resumed via `mill run <id>`, but reject is the documented "this is wrong, stop" terminal.
   - UI:
     - Dashboard: badge "N pending approvals" linking to a filtered runs list.
     - Project view: status filter "awaiting approval".
     - Run view: prominent "Approve" / "Reject" buttons when status is `awaiting_approval`, with the gate stage and a diff-style summary of what's been produced so far (spec text, design output, etc., depending on stage).
   - Approvals are recorded as events with the actor, timestamp, and optional note. The audit trail is immutable.

5. **Outbound notifications.**
   - New table `project_webhooks`: `(id, project_id, url, event_filter, secret, enabled, created_at)`. `event_filter` is a comma-separated list of event types (e.g. `run.completed,run.failed,finding.high`).
   - CLI: `mill project webhooks add <project> --url <url> --events <list> [--secret <token>]`, `mill project webhooks ls <project>`, `mill project webhooks rm <id>`.
   - Daemon: a small queue worker (separate from the run executor) consumes a notification queue and POSTs to webhook URLs.
   - Payload: JSON `{event, ts, run_id?, project_id, project_name, summary, url}` where `url` is the absolute UI URL for the run (when relevant). If `secret` is set, include `X-Mill-Signature: sha256=<hmac>` over the body.
   - Retry: 3 attempts with exponential backoff (1s, 5s, 30s). Failures logged but not surfaced as run failures.
   - Supported events in Phase 3: `run.completed`, `run.failed`, `run.killed`, `finding.high` (one per HIGH finding emerging from a review iteration), `approval.required`, `budget.warning_80`, `budget.exceeded`.

6. **Actor tracking everywhere.**
   - The `events` table gets an `actor TEXT` column. Stage events use `actor = 'mill'`; user-initiated events (kill, approve, reject, resume, project add/rm, webhook add/rm) use the authenticated session's user identifier (or `MILL_USER` env when running unauthenticated locally).
   - Migration: existing rows backfilled with `'mill'`.

7. **CLI ergonomics for the new state machine.**
   - `mill status` shows `paused_budget`, `awaiting_approval`, and the gate stage in its compact output.
   - `mill approve <run-id> [--note "..."]` and `mill reject <run-id> --note "..."` mirror the API.
   - `mill resume <run-id>` resumes a `paused_budget` run after a budget bump.

## Acceptance criteria

- **AC-1** With `MILL_AUTH_TOKEN` unset, the daemon starts on loopback and the API works without auth (Phase 1–2 behavior).
- **AC-2** With `MILL_AUTH_TOKEN=foo`, every `/api/v1/*` request without `Authorization: Bearer foo` returns 401. The token comparison is constant-time.
- **AC-3** `mill daemon start --bind lan` fails fast with a clear error when `MILL_AUTH_TOKEN` is unset. The same with `--bind all`.
- **AC-4** `mill daemon start --bind lan` (with auth set) binds to the host's primary LAN IPv4 and serves the API + UI there. `curl https://<host>/api/v1/health` (or http with `--insecure`) reaches the daemon.
- **AC-5** `mill auth init` generates a 32-byte random token, writes it to `~/.mill/auth.token` with mode 0600, and prints the value once.
- **AC-6** Browser auth: visiting the UI without a session cookie redirects to a login screen; entering the correct token sets a cookie and unlocks the dashboard. Wrong token returns to the login screen with an error. Logout clears the cookie and the session row.
- **AC-7** Pre-flight budget: with `projects.monthly_budget_usd = 10` and current monthly spend $9.99, `POST /projects/:id/runs` succeeds. With current spend $10.50, it returns 402 and an explanatory body.
- **AC-8** In-flight budget: a run that crosses the cap mid-stage is paused at the next stage boundary. `runs.status = 'paused_budget'`, no further `claude` subprocesses spawn for that run, and the UI run view shows the paused state.
- **AC-9** `POST /api/v1/runs/:id/resume` on a `paused_budget` run with project still over budget returns 402. With budget raised, it transitions to `running` and resumes from the next stage.
- **AC-10** Setting an approval gate: `mill project gates set my-project design` writes a row. A new run in `my-project` pauses with `status = 'awaiting_approval'` after the design stage; the run view shows Approve/Reject buttons.
- **AC-11** `POST /api/v1/runs/:id/approve` with a valid session moves status to `running` and the next stage starts. `POST /api/v1/runs/:id/reject` with a `note` moves status to `failed` with reason `rejected`.
- **AC-12** Approval events include the actor's identifier (from the session user) and timestamp. They are visible in `mill logs <run-id>`.
- **AC-13** Webhook delivery: with a webhook configured for `run.completed`, finishing a run causes a POST to the URL within 5 seconds, with `X-Mill-Signature` matching the HMAC-SHA256 of the body using the configured secret.
- **AC-14** Webhook retry: a webhook URL returning 500 is retried 3 times with backoff. After the third failure, the daemon logs and stops retrying that delivery (does not block subsequent events).
- **AC-15** `mill status <run-id>` reflects the new states (`paused_budget`, `awaiting_approval`).
- **AC-16** Budget warning: a run that pushes monthly spend across 80% emits a `budget.warning_80` event once per project per month. The UI dashboard shows a yellow chip.
- **AC-17** Auth migration: existing daemon installs without auth keep working (no forced auth introduction). `mill auth init` is opt-in.
- **AC-18** Existing CLI commands and tests continue to pass — Phase 3 must not regress Phases 1–2.
- **AC-19** Documentation: `README.md` documents auth setup, bind modes (with HTTPS guidance), budget caps, approval gates, and webhook configuration. `.env.example` lists `MILL_AUTH_TOKEN`.

## Architectural decisions (already made — do not re-derive)

1. **Bearer token, not OIDC, in Phase 3.** Single deployment + small team. OIDC integration is real work and the value vs. a strong shared token is marginal. Phase 4+ can add OIDC if needed.

2. **All-or-nothing auth.** No anonymous read endpoints, no scoped tokens. Adding scoped tokens means designing a permissions model; that's its own project. Phase 3 says "logged in or out, full access or none."

3. **Sessions are DB-backed, not stateless JWTs.** A DB-backed session table allows immediate logout / token-rotation invalidation. Performance cost is one indexed lookup per request — fine for our throughput.

4. **HTTPS is the user's responsibility (or `--cert`/`--key`).** Mill does not provision certs. Document the reverse-proxy path (Caddy / Cloudflare Tunnel) prominently.

5. **Budget pauses at stage boundaries, not mid-stage.** Stage-mid SIGTERMs are the kill path; budget enforcement is graceful. The cost may overshoot the cap by one stage's worth; this is acceptable and documented.

6. **Approval gates are stored as `(project_id, stage_name)` rows.** Per-run overrides are out of scope; if the user wants a one-off approval, they can `mill project gates set` before starting and clear afterward, or the policy can mature in a future phase.

7. **Webhooks are best-effort.** No durable queue for delivery, no exactly-once guarantees. Three retries with backoff, then drop. If reliable delivery ever matters, that's a Phase 4 swap (Redis / SQS / etc.).

8. **The webhook payload includes a UI URL.** That URL is constructed from a new `MILL_PUBLIC_URL` env (e.g. `https://mill.local:7333`). When unset, the URL field is omitted. Documented in `.env.example`.

9. **Actor tracking is mandatory for new event types.** Stage events keep `actor = 'mill'`; user actions get the session user. This makes the audit trail real, which is the whole point of an approval system.

10. **The pipeline driver handles three pause/abort signals consistently:** `KILLED` (user kill, hard), `paused_budget` (graceful, resumable), `awaiting_approval` (graceful, resumable). All three unwind via dedicated error types and persist the run row in the right state. Adding a fourth class in a future phase should follow the same pattern.

## Out of scope

- OIDC, OAuth, SAML, SSO of any kind.
- Multi-tenancy beyond per-project isolation that already exists.
- Granular RBAC / role-based permissions.
- Approval gates with multi-approver thresholds, rotation, or delegation.
- Routine scheduling (cron, webhook-triggered runs) — Phase 4.
- Plugin system for custom critics or stages — Phase 4.
- Audit log export, e-discovery features.
- Email notifications (webhooks suffice; users can plug Slack/Discord/email-relay in via the URL).
- Per-stage cost caps (today's per-stage budget is global; per-project per-stage caps could come later).
- Hosted / managed mode — this is self-hosted only.
- Custom themes, white-labeling.
- Mobile app, push notifications.
- Multi-region / HA deployment.
- Encryption at rest for `~/.mill/mill.db` (assume host disk encryption is the user's responsibility).

## Constraints

- **No regression of Phases 1–2.** All existing endpoints, CLI commands, and UI screens must keep working. Adding fields to API responses is fine; removing or renaming is not.
- **TypeScript conventions in `CLAUDE.md` are ground truth.**
- **Schema migrations must be additive and backwards-compatible.** Existing DBs upgrade in place; downgrade is not required (note in release notes).
- **No new heavyweight dependencies.** HMAC and constant-time comparison from Node's `crypto`. No JWT library, no auth framework. Cookie handling: hand-rolled or a 1-file dep.
- **The pipeline driver's existing semantics are preserved.** `BudgetPausedError` and `ApprovalRequiredError` follow the same pattern as `KilledError`: caught at the stage boundary, run row updated, stack unwound cleanly. No mid-stage interruption.
- **Webhook outbound calls use a strict timeout (5s) and never block run progress.** A slow / unresponsive webhook URL must not stall the daemon's event loop.
- **All new state-changing endpoints require auth when auth is configured.** No accidental escape hatches.
- **Token comparison is constant-time** (`crypto.timingSafeEqual`).
- **Cookies for the UI session are `HttpOnly`, `Secure`, `SameSite=Strict`.**
- **Crash recovery still works.** Runs in `paused_budget` or `awaiting_approval` survive daemon restart and remain in their paused state. The pipeline driver does not auto-resume them; explicit user action (or a budget rollover next month) is required.

## Open questions

These should be surfaced by the clarification stage:

1. **Token rotation:** when `mill auth rotate` runs, do existing sessions get invalidated, or only new logins use the new token? Lean: invalidate all sessions. Forced re-login on rotate is the safer default.
2. **Session lifetime:** how long does a UI cookie last? Lean: 30 days, sliding expiration. Configurable via `MILL_SESSION_LIFETIME_DAYS`.
3. **Multiple actors:** Phase 3 has a single token but the UI accepts a free-form "name" at login that's recorded as the actor on actions. Is that worth doing? Lean: yes, low cost, makes the audit trail meaningful even with one shared token.
4. **Budget computation timezone:** UTC or host local? Lean: UTC, matching the way `runs.created_at` is stored. Document and surface the cutover time in the UI.
5. **Approval scope:** should approval gates support "skip a specific stage entirely" in addition to "pause and approve"? Lean: no — skip-stage is a different feature, can be added later with `mill run --skip-stage`. Phase 3 is just pause + approve/reject.
6. **Webhook signing:** require a secret, or default to unsigned? Lean: require a secret on creation; error otherwise. Forward-compatible if we later add signed-by-default.
7. **What happens when a webhook URL becomes invalid (DNS NXDOMAIN, repeated 4xx)?** Auto-disable after N consecutive failures? Lean: yes, after 10 consecutive failures, set `enabled = 0` and emit a `webhook.disabled` event.
8. **HTTPS in process vs reverse proxy as the documented path:** which gets the spotlight in `README.md`? Lean: reverse proxy (more flexible, cleaner cert lifecycle). `--cert/--key` exists for users who want it embedded.
9. **Approval UI summary content:** for the design stage, show the design markdown; for the implement stage, show a git diff. Is this a separate render module per gateable stage, or a single "summary preview" pulled from the stage's `artifact_path`? Lean: render the artifact's content with a stage-aware formatter; keep the formatters small and per-stage.
10. **Per-project budget reset semantics:** does the cap reset at the start of each calendar month UTC, or N days after first run, or sliding 30-day window? Lean: calendar month UTC. Predictable and matches every billing system.

## References (files this will touch)

- `src/cli.ts` — `mill auth`, `mill project gates`, `mill project webhooks`, `mill approve`, `mill reject`, `mill resume` subcommands.
- `src/daemon/server.ts` — auth middleware, login/logout endpoints, approval/resume/reject endpoints, webhook CRUD endpoints, bind-mode validation.
- `src/daemon/auth.ts` (new) — token validation, session create/lookup/delete, constant-time compare, cookie issuance.
- `src/daemon/notify.ts` (new) — webhook delivery worker with retry and HMAC signing.
- `src/daemon/budget.ts` (new) — monthly-spend computation, pre-flight check, in-flight check helper.
- `src/orchestrator/pipeline.ts` — gate-check between stages; introduce `BudgetPausedError`, `ApprovalRequiredError` mirroring `KilledError`.
- `src/orchestrator/context.ts` — surface project budget / gate config on the context.
- `src/core/store.sqlite.ts` — schema migrations: `events.actor`, `project_approval_gates`, `project_webhooks`, `sessions`. Helpers for budget queries and gate lookup. `addStageCost` calls budget check.
- `src/core/types.ts` — new run statuses (`paused_budget`, `awaiting_approval`); new event kinds.
- `web/src/screens/login.tsx` (new) — login screen.
- `web/src/screens/run.tsx` — Approve/Reject UI when status is `awaiting_approval`; paused-budget banner with Resume button.
- `web/src/screens/project.tsx` — gates and webhooks settings panel.
- `web/src/screens/dashboard.tsx` — pending-approvals badge, budget warning chips.
- `web/src/api/*.ts` — typed clients for new endpoints; cookie-based auth handling; redirect-to-login on 401.
- `README.md`, `.env.example`, `CLAUDE.md` — auth setup, bind modes, budget enforcement, approval gates, webhook configuration.

The orchestrator stage logic itself (`stages/*`, `critics/*`, `retry.ts`, `claude-cli.ts`, `guard.ts`, `run-settings.ts`, `progress.ts`) does not need behavioral changes for Phase 3.
