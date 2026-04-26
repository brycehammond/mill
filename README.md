# mill

A command-line harness around the `claude` CLI. Feed it a requirement, answer
one batch of clarifying questions, and the pipeline runs dark — spec, design,
implement, review, verify, deliver — spawning `claude` subprocesses at each
stage and persisting everything to SQLite.

```
intake → clarify → [USER: answer] → spec
                   ↓ (dark from here)
design → (spec2tests?) → implement ⇄ review (≤3 iters) → verify → deliver → decisions
```

## Setup

Install Claude Code with the official installer (not npm):

```sh
# macOS / Linux / WSL
curl -fsSL https://claude.ai/install.sh | bash

# Windows PowerShell
irm https://claude.ai/install.ps1 | iex

claude --version        # sanity
```

See the [Claude Code install docs](https://docs.claude.com/en/docs/claude-code/setup)
for Homebrew and other options.

Then install `mill` from this checkout:

```sh
git clone git@github.com:brycehammond/mill.git
cd mill
npm install             # better-sqlite3 builds natively
npm run build           # compiles src/ → dist/ + copies prompts
npm link                # puts `mill` on your PATH
mill --help
```

Start the daemon (it owns run execution, exposes a localhost HTTP
API the CLI talks to, and serves the web UI from the same port) and
register a repo:

```sh
mill daemon start                  # binds 127.0.0.1:7333; pidfile at ~/.mill/daemon.pid
                                   # UI at http://127.0.0.1:7333/
cd /path/to/your/repo
mill project add                   # registers cwd in the central registry at ~/.mill/
```

Pass `--open` to launch the dashboard in your browser, or `--no-ui`
for an API-only daemon (CI, headless servers).

`mill project add` is idempotent and migrates any existing per-repo
`.mill/mill.db` into the central DB on first registration (legacy file
is renamed to `.mill/mill.db.legacy-<ts>`, never deleted). `mill init`
is kept as a deprecated alias.

Requires Node ≥ 22. `claude` handles auth via its own login flow
(subscription or workspace); mill scrubs `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN` from the env it passes to `claude`, so an
API key in your shell can't accidentally route billing through the API.

## Usage

```sh
# Daemon — owns run execution; CLI mutating commands talk to it over
# localhost HTTP. Read-only commands (status, tail, logs, history,
# findings, project ls) work even when the daemon is down.
mill daemon start                   # detached; pidfile at ~/.mill/daemon.pid
mill daemon start --foreground      # run in this shell for development
mill daemon status
mill daemon stop                    # SIGTERM, drains in-flight runs

# Projects — first-class entities in the central registry at ~/.mill/.
mill project add [<path>]           # default cwd; idempotent; migrates legacy .mill/
mill project ls
mill project show <id>
mill project rm <id> [--yes]

# Start a new run from inside a registered repo. Pass --project <id> from
# anywhere else. Prompts clarifying questions inline, then runs dark.
# Stages stream progress (▸ start, ✓ ok, ✗ failed, ⊘ skipped). Close the
# terminal anytime — the daemon keeps the run going; resume polling with
# `mill tail <id> -f`.
mill new "TypeScript CLI that converts markdown to minified HTML"

# Edit-mode run on an existing repo (auto-detected when the repo has
# committed source). Names the branch from the requirement —
# `mill/refactor-auth-middleware-xyzz` instead of an opaque run id —
# and creates it via `git worktree add`. The branch lands in the parent
# repo's `git branch -a` after a clean delivery; review/merge yourself.
mill new "refactor the auth middleware" --mode edit

# Stop after a named stage so you can review before paying for the rest.
# Resume with `mill run <id>` to continue.
mill new "..." --stop-after design

# Resume a partially-completed run (crash recovery, or after --stop-after).
mill run <run-id>

# Inspect state (daemon-optional).
mill status [<run-id>]
mill tail   <run-id> --follow   # human-readable activity stream
mill logs   <run-id> --follow   # raw events
mill kill   <run-id>

# Cross-run memory (per-project; lives at ~/.mill/projects/<id>/).
mill history [--project <id>]   # print the project journal
mill findings                   # recurring findings across runs
mill findings suppress <fp>     # silence a known false positive
mill onboard                    # profile the repo for future runs
```

The repo-local `<repo>/.mill/runs/<id>/workdir/` directory still exists
— that's where the per-run sandboxed workdir lives so Claude Code's
CLAUDE.md auto-discovery and the `git worktree add` flow keep working.
Management state (DB, journal, decisions, profile, stitch) all moved to
`~/.mill/`.

## Web UI

Once the daemon is running, the same port serves a small React SPA at
`http://127.0.0.1:7333/`. Five screens cover the CLI's surface:

- **Dashboard** — cross-project rollup: today's cost, MTD cost, runs
  in flight, per-project cards, top recurring findings.
- **Project view** (`/projects/:id`) — start a new run from a textarea
  (with the same clarification questions the CLI asks), browse the
  project's runs, and see its scoped findings ledger. A "view report →"
  link in the header opens the project report below.
- **Project report** (`/projects/:id/report`) — read-only audit surface
  consolidating everything mill knows about a project: lifetime
  aggregates (total cost, success rate, avg duration, token totals),
  cost-by-month bars, per-stage rollups (cost / completion / duration),
  the full uncapped runs history, inline stage + findings detail for
  the most recent runs, the project's findings ledger, and the rendered
  markdown of `journal.md`, `decisions.md`, and `profile.md` plus the
  Stitch project ref.
- **Run view** (`/runs/:id`) — live SSE-streamed activity feed, stage
  timeline, kill button, per-stage cost breakdown. Reconnects use the
  browser's native `Last-Event-ID` replay so no frames are dropped on
  network blips.
- **Findings ledger** (`/findings`) — cross-project recurring findings
  with one-click suppress / unsuppress. Suppressed entries persist in
  the central DB and the same fingerprints disappear from
  `mill findings`.

By default the daemon binds loopback with no auth — fine for solo /
shared-laptop use. To expose it beyond this host (LAN, public via a
reverse proxy, or to share the UI with collaborators) configure auth
and a non-loopback bind:

```sh
mill auth init                                  # writes ~/.mill/auth.token (0600), prints once
export MILL_AUTH_TOKEN="$(cat ~/.mill/auth.token)"
mill daemon start --bind lan --cert ./fullchain.pem --key ./privkey.pem
# or, behind a reverse proxy that terminates TLS:
mill daemon start --bind lan --insecure
```

See **Auth and bind modes** below for the full story (rotation, session
cookies, --bind values, HTTPS guidance).

### Hacking on the UI

In dev, run Vite's dev server alongside the daemon (don't let the
daemon serve stale static files):

```sh
# terminal 1
MILL_DEV=1 mill daemon start --foreground

# terminal 2
cd web && npm run dev               # Vite at http://localhost:5173
```

Vite proxies `/api`, `/healthz`, `/projects`, `/runs`, `/findings` to
the daemon, so HMR keeps working while the API calls go to the real
server. `npm run build` at the repo root builds both the daemon JS
(`dist/`) and the UI bundle (`dist/web/`); the npm artifact ships
both.

## Auth and bind modes

mill defaults to no auth on loopback (Phase 1–2 behavior is preserved
verbatim — set nothing and nothing changes). Opt in once you need to
share the daemon with others or expose it on a network.

### Token

```sh
mill auth init        # generates a 32-byte token, writes ~/.mill/auth.token (mode 0600), prints once
mill auth show        # prints the stored token
mill auth rotate      # generates a new token AND invalidates every existing UI session (forced re-login)
```

`MILL_AUTH_TOKEN` in the env wins over the file. The CLI client reads
either source automatically and attaches `Authorization: Bearer <token>`
to every daemon request. With auth configured, every `/api/v1/*` route
returns 401 without a valid bearer or `mill_session` cookie. Comparison
is `crypto.timingSafeEqual` (constant-time).

### Bind modes

```sh
mill daemon start --bind loopback         # default — 127.0.0.1
mill daemon start --bind lan              # primary LAN IPv4 (auth required)
mill daemon start --bind all              # 0.0.0.0       (auth required)
```

Non-loopback binds **refuse to start** without `MILL_AUTH_TOKEN`. They
also require either TLS (`--cert <path> --key <path>`) or an explicit
`--insecure` opt-in (intended for "I'm behind a reverse proxy that
terminates TLS").

### HTTPS

Two paths, in order of preference:

1. **Reverse proxy** (recommended). Run mill on loopback (or `--bind
   lan --insecure` on a private network) and let Caddy / Cloudflare
   Tunnel / nginx / Traefik terminate TLS. Cleaner cert lifecycle,
   easier rotation, and the proxy can add headers / rate limits.
   Example with Caddy:
   ```
   mill.example.com {
     reverse_proxy 127.0.0.1:7333
   }
   ```
2. **Embedded TLS** (`--cert / --key`). Useful when you really do want
   one process and not two. mill does not provision certs — bring your
   own (Let's Encrypt, mkcert for LAN dev, etc.).

### Web UI sessions

Visiting the UI without a `mill_session` cookie redirects to a login
screen. Submit the token plus a free-form actor name (your email,
"on-call", whatever — it's recorded as the actor on every approval /
rejection / kill / webhook config you make). On success you get an
`HttpOnly Secure SameSite=Strict` cookie valid for
`MILL_SESSION_LIFETIME_DAYS` (default 30) with sliding expiry on every
authenticated request. Logout clears both the cookie and the DB row;
`mill auth rotate` invalidates every active session at once.

When `MILL_AUTH_TOKEN` is unset the UI loads without a login screen
and the daemon serves `/api/v1/*` openly (Phase 1–2 contract).

## Per-project budget caps

Each project can carry a soft monthly USD cap (`projects.monthly_budget_usd`,
set when registering or via `mill project show <id>` plus the daemon
API). Computation: sum of `runs.total_cost_usd` for runs created in the
current calendar month UTC. Behavior:

- **Pre-flight.** Starting a new run when the project is already over
  budget returns HTTP 402 with the current spend and cap. The CLI
  surfaces this inline.
- **In-flight.** When a stage's cost delta crosses the cap, the run is
  marked `paused_budget` at the next stage boundary (no mid-stage
  interrupts — that's the kill path's job). The pipeline persists state
  cleanly via `BudgetPausedError`. The cap may overshoot by one stage;
  this is intentional.
- **Soft warning.** Crossing 80% of the cap emits a single
  `budget_warning_80` event per project per month (idempotent). The UI
  dashboard renders a yellow chip; webhooks fire on `budget.warning_80`.
- **Resume.** `mill resume <run-id>` (or the UI's Resume button) tries
  to continue. Returns 402 again if you're still over; succeeds after a
  cap raise or once the calendar month rolls over.

Caps are independent of `MILL_TIMEOUT_SEC_*` (those are wall-clock).

## Approval gates

Park runs at named stage boundaries for human review.

```sh
mill project gates set <project> design,implement   # pause after design AND after implement
mill project gates ls <project>
mill project gates clear <project>
```

A gated stage's completion sets `runs.status = awaiting_approval` and
`runs.awaiting_approval_at_stage = <next stage>`, persists an
`approval_required` event, and unwinds via `ApprovalRequiredError`. The
next stage doesn't start until you act:

```sh
mill approve <run-id> [--note "..."]   # resume from the next stage
mill reject  <run-id> --note "why"     # mark failed with reason=rejected
mill resume  <run-id>                   # for paused_budget; same path used for retries after a cap raise
```

The same actions are available on the run view in the UI as Approve /
Reject buttons (with a required-note modal on reject) plus a Resume
button on `paused_budget` runs. Approve/reject events carry the
authenticated actor and an optional note — that's the audit trail.

## Webhooks

Outbound notifications, per-project, signed.

```sh
mill project webhooks add <project> --url https://hooks.example.com/mill --events run.completed,run.failed,finding.high --secret "$(openssl rand -hex 16)"
mill project webhooks ls <project>
mill project webhooks rm <webhook-id>
```

Supported events: `run.completed`, `run.failed`, `run.killed`,
`finding.high`, `approval.required`, `budget.warning_80`,
`budget.exceeded`. Each delivery POSTs JSON
`{event, ts, run_id?, project_id, project_name, summary, url?}` (the
`url` field is included when `MILL_PUBLIC_URL` is set so receivers can
deep-link back to a run) with header
`X-Mill-Signature: sha256=<hmac_hex>` over the raw body using your
secret. Secrets are required at creation time (the daemon refuses
unsigned hooks).

Delivery is best-effort:

- 5s timeout per attempt.
- 3 retries with 1s / 5s / 30s backoff.
- After **10 consecutive failures** the webhook is auto-disabled
  (`enabled = 0`) and a `webhook_disabled` event is emitted for the
  project.

A slow / failing webhook URL never blocks run progress.

## How it works

Each pipeline stage calls `runClaude()` in `src/orchestrator/claude-cli.ts`,
which `spawn`s the `claude` binary with flags for that stage:

- `--json-schema <schema>` forces structured output from clarify, design-ui,
  verify, and the critics. We pass a zod schema converted to JSON Schema.
- `--resume <session-id>` keeps the implementer's session across review
  iterations; each critic resumes its own session. IDs are stored in SQLite.
- `--allowedTools` / `--disallowedTools` scope what each stage can do. The
  implementer gets full edit power inside its workdir; critics are read-only.
- `--setting-sources user,project` tells Claude Code to pick up the user's
  global config (skills like a `commit` skill that suppresses Claude
  attribution, hooks, MCP servers like Stitch / Playwright) plus our per-run
  `.claude/settings.json` (the sandbox hook). Set `MILL_USER_HOOKS=off` for
  project-only isolation.

**Per-run sandbox.** For every run, the harness writes
`.mill/runs/<id>/.claude/settings.json` with a `PreToolUse` hook pointing at
`guard.ts`. The guard:

- rejects any tool call if `.mill/runs/<id>/KILLED` exists (`mill kill` path)
- rejects Write/Edit outside the workdir (plus stage-specific extras like
  `.mill/runs/<id>/verify/`)
- blocks `rm -rf /`, `sudo`, and related destructive commands

The harness never calls the Anthropic API itself — `claude` does. We just
orchestrate, sandbox, and persist. Auth runs through the user's Claude
subscription (the harness scrubs `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
from the env handed to `claude`), so there is no per-run dollar cap to
enforce; cost numbers in the delivery report are tally-only.

**Where the result lands.**

- **Edit mode**: the implementer commits onto a fresh
  `mill/<slug-from-requirement>-<short-id>` branch checked out via
  `git worktree add` (in `stages/intake.ts`). After a clean delivery
  the branch is in the parent repo's `git branch -a` — review with
  `git diff <base>..<branch>`, then `git switch` or `git merge` it.
  The per-run workdir at `.mill/runs/<id>/workdir/` is just where the
  harness sandboxes file writes during the run; clean it up with
  `git worktree remove <workdir>` when you're done.
- **New mode**: the implementer builds a self-contained codebase
  inside `.mill/runs/<id>/workdir/` with its own git history. After a
  clean delivery (verify pass + zero unresolved HIGH+), `deliver`
  promotes the workdir contents up into the project root so the
  result is "right there" instead of buried under `.mill/`. `.git/`
  is skipped (the workdir's history stays accessible at
  `.mill/runs/<id>/workdir/.git/` for cherry-picking); `.gitignore`
  is *merged* (workdir's language-specific rules + the parent's
  `/.mill/` rule both survive). Gated by `MILL_PROMOTE_NEW_WORKDIR`
  (`auto` default refuses to clobber a populated parent root). In
  parallel, `deliver` also imports the workdir's branch into the
  parent repo (init'ing `.git` if missing) so `git log` at the parent
  shows the run's commits.

## Critics

The review stage runs critics in parallel (`Promise.allSettled`) after each
implement iteration. Any HIGH/CRITICAL finding feeds back into the next
implement turn. The loop stops at max iterations, when no HIGH+ findings
remain, or when the current set is a subset of the previous iteration's
(stuck detection).

| Critic | What it looks for | Backed by |
|---|---|---|
| security | Injection, secret leaks, auth bypass, unsafe crypto | Claude (read-only) |
| correctness | Bugs, wrong logic, off-by-one, races, missing edge cases | Claude (read-only) |
| ux | Empty-state gaps, confusing copy, accessibility, error messaging | Claude (read-only) |
| tests | Resolved test command (set by `spec2tests` in new-mode runs, or from `.mill/profile.json` in edit-mode) — non-zero exit = HIGH | Subprocess (no LLM) |
| adversarial *(opt-in)* | Second-opinion pass from an independent model | Codex CLI |

All findings persist to SQLite with a canonical fingerprint
(`critic|severity|title`), which is what powers the ledger, suppression list,
and stuck detection.

### Optional: adversarial review via Codex

If the [Codex Claude Code plugin](https://github.com/openai/codex) is
installed and the `codex` CLI is authed, the review stage adds a fourth
critic backed by `/codex:adversarial-review`. It runs alongside the others
against the cumulative diff from `impl/iter-0` and feeds findings into the
same implement⇄review loop.

Enable: `/plugin marketplace add openai/codex` then `/plugin install
codex@openai-codex` in Claude Code, and `!codex login`. Auto-detects by
default; set `MILL_ADVERSARIAL_REVIEW=off` to disable, or `=on` to require it
(stage fails if unavailable).

## Cross-run memory

Per-project state lives centrally at `~/.mill/projects/<project-id>/`
and is auto-injected into stage prompts (or consulted by the
orchestrator before it picks a prompt):

- **`journal.md`** — one stanza per completed run. Activity log: what was
  asked, what shipped, cost. Written by the deliver stage.
- **`decisions.md`** — ADR-lite entries for non-obvious design
  trade-offs the run resolved. Written by the `decisions` sub-stage after
  deliver, strictly gated: each entry must cite a specific finding, spec
  criterion, or external constraint. A clean run produces zero entries.
- **`profile.json`** — one-shot repo profile (language, test command,
  conventions). Written by `mill onboard`, refreshed with `mill onboard --refresh`.
- **`stitch.json`** — Stitch project URL + originating run id.
  Written by `design.ui` after a successful UI design. Edit-mode UI runs
  that find this file load `prompts/design-ui-edit.md` instead of
  `prompts/design-ui.md` and reuse the project via `edit_screens`
  rather than calling `create_project` each time. Stale URLs are
  recovered automatically (the edit prompt instructs the model to fall
  back to `create_project` if `get_project` returns not-found).

Plus the **findings ledger** — aggregated across runs from the `findings`
SQLite table. Shown by `mill findings`, and the top recurring entries are
injected into edit-mode prompts so the implementer preempts issues that
keep getting flagged on this repo.

| File | Answers | Triggered by |
|---|---|---|
| journal.md | What did mill do last time? | Every completed run |
| decisions.md | What design debates have we already resolved? | Post-deliver, only for non-obvious trade-offs |
| ledger (SQLite, `~/.mill/mill.db`) | What bugs keep recurring? | Every review stage |
| profile.json | What is this repo? (language, test cmd) | `mill onboard` |
| stitch.json | Which Stitch project should we keep editing? | Every successful UI design |

## Layout

```
src/
├── cli.ts                          # mill new|run|status|logs|tail|kill|history|
│                                   # findings|onboard + project|daemon subcommand trees
├── cli/
│   └── client.ts                   # thin HTTP client for the daemon
├── core/                           # types, SQLite store, paths, costs, logger
│   ├── journal.ts | ledger.ts | decisions.ts | profile.ts | project.ts
│   ├── migrate.ts                  # legacy <repo>/.mill/mill.db → central import
│   └── store.sqlite.ts
├── daemon/                         # localhost HTTP daemon (Hono on Node)
│   ├── server.ts                   # routes: /projects, /runs, /findings
│   ├── run-loop.ts                 # cross-project run scheduler (global cap)
│   └── index.ts                    # entrypoint: bind 127.0.0.1:7333, pidfile, drain
└── orchestrator/
    ├── pipeline.ts                 # stage state machine
    ├── worker.ts                   # legacy single-project polling loop (deprecated)
    ├── claude-cli.ts               # `claude` subprocess runner
    ├── guard.ts                    # PreToolUse hook binary
    ├── run-settings.ts             # writes per-run .claude/settings.json
    ├── context.ts | config.ts | git.ts | prompts.ts | onboard.ts
    ├── stages/                     # intake, clarify, spec, design(.ui|.arch),
    │                               # spec2tests, implement, review, verify,
    │                               # deliver, decisions
    └── critics/                    # security, correctness, ux, tests,
                                    # adversarial (shared.ts has the common runner)

src/prompts/*.md                    # stage + critic system prompts, iterable
                                    # without rebuild (tsx reads from src/)

~/.mill/                            # central management state (one tree per host)
├── mill.db                         # SQLite: projects, runs, stages, findings, sessions
├── daemon.pid                      # daemon process id (written by `mill daemon start`)
├── daemon.port                     # actual port if a non-default one was used
└── projects/<project-id>/          # per-project durable state
    ├── journal.md | decisions.md   # cross-run memory
    ├── profile.json | profile.md   # repo profile (mill onboard)
    └── stitch.json                 # Stitch project ref (UI runs)

<repo>/.mill/                       # per-repo (workdirs only — no DB, no journal)
└── runs/<id>/                      # per-run artifacts; stays in the repo so
    ├── .claude/settings.json       #  CLAUDE.md auto-discovery + git worktree
    ├── KILLED                      #  flow keep working
    ├── requirement.md | spec.md
    ├── design/                     # design-intent.md or architecture.md
    ├── workdir/                    # where the implementer edits
    ├── reviews/<iter>/             # per-critic reports
    ├── verify/                     # verify outputs
    └── delivery.md
```

## Environment

See `.env.example`. Relevant knobs:

| Var | Default | Purpose |
|---|---|---|
| `MILL_TIMEOUT_SEC_PER_RUN` | 14400 | Wall-clock cap per run (4h) |
| `MILL_TIMEOUT_SEC_PER_STAGE` | 600 | Wall-clock cap per stage (default; overridden below) |
| `MILL_TIMEOUT_SEC_IMPLEMENT` | 7200 | Wall-clock cap for the implement stage (2h — TDD builds are 100+ tool calls) |
| `MILL_TIMEOUT_SEC_VERIFY` | 1800 | Wall-clock cap for verify (30m — end-to-end checks take a while) |
| `MILL_MAX_REVIEW_ITERS` | 3 | implement ⇄ review loop cap |
| `MILL_MAX_CONCURRENT_RUNS` | 2 | Daemon's global cap (sum across all projects) |
| `MILL_MODEL` | (claude default) | Pass to every `claude` invocation |
| `MILL_HOME` | `~/.mill` | Central state root (DB + per-project state) |
| `MILL_DAEMON_HOST` | `127.0.0.1` | Daemon HTTP bind host (overridden by `--bind`) |
| `MILL_DAEMON_PORT` | `7333` | Daemon HTTP bind port |
| `MILL_AUTH_TOKEN` | (unset) | Bearer token. Unset = no auth. Required for non-loopback `--bind`. Generate with `mill auth init`. |
| `MILL_SESSION_LIFETIME_DAYS` | `30` | UI cookie lifetime (sliding) |
| `MILL_PUBLIC_URL` | (unset) | Externally-reachable daemon URL embedded in webhook payloads' `url` field |
| `MILL_ADVERSARIAL_REVIEW` | auto | `auto` \| `on` \| `off` — optional Codex critic |
| `MILL_TESTS_CRITIC` | auto | `auto` \| `on` \| `off` — mechanical test critic |
| `MILL_SPEC2TESTS` | auto | `auto` \| `on` \| `off` — generate test scaffolds from spec |
| `MILL_AGENT_TEAMS` | auto | `auto` \| `on` \| `off` — review critics share one `claude` subprocess via parallel Agent subagents |
| `MILL_PROMOTE_NEW_WORKDIR` | auto | `auto` \| `on` \| `off` — copy a clean new-mode workdir up into the project root after delivery (`auto` skips when the parent has user content beyond `{.git, .gitignore, .mill}`) |
| `MILL_USER_MCP_CONFIG` | (both `~/.claude/settings.json` and `~/.claude.json`) | Single explicit JSON file to source user-level MCPs from when stages pass `inheritUserMcps: true` |
| `MILL_CODEX_COMPANION` | (auto-discover) | Absolute path to `codex-companion.mjs` |

## Hacking on mill

```sh
npm run typecheck    # tsc --noEmit
npm test             # node --test under tsx, src/**/*.test.ts (~70 cases)
npm run build        # tsc + cp -r src/prompts dist/prompts
```

`npm test` runs Node's built-in test runner under `tsx` with no extra
deps. Coverage is intentionally pure-function-shaped — the harness
`spawn`s `claude`, so end-to-end tests would burn live subscription
tokens. Today's suites pin: cost tally, severity ordering + finding
fingerprint, store round-trip via `:memory:`, JSON / markdown
extractors, retry-with-hint guards (including the terminal-subtype
guard), `shouldStopReviewLoop`, slug derivation, workdir promotion
safety, the live-progress ticker, and the Stitch project ref. When
adding a new pure helper or load-bearing invariant, drop a
colocated `*.test.ts` next to it.

`npm run build`'s `cp -r src/prompts dist/prompts` fails if
`dist/prompts` already exists (macOS `cp` copies *into* rather than
replacing). Always `npm run clean && npm run build` for a full build.
Prompts are loaded at runtime from `src/prompts/` under `tsx`, so you
can iterate on prompt wording in dev without rebuilding.

CLAUDE.md in this repo is the contributor handbook — read it before
making invasive changes (especially around `pipeline.ts`, `claude-cli.ts`,
or the per-run sandbox).

## License

MIT — see [LICENSE](./LICENSE).
