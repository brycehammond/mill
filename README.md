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

Per-repo init — creates `.mill/` at the git root:

```sh
cd /path/to/your/repo
mill init
```

Requires Node ≥ 22. No `ANTHROPIC_API_KEY` needed — `claude` handles auth via
its own login flow (subscription or workspace). Setting `ANTHROPIC_API_KEY`
will silently switch `claude` to API billing.

## Usage

```sh
# Start a new run. Prompts clarifying questions inline, then runs dark.
mill new "TypeScript CLI that converts markdown to minified HTML"

# Edit-mode run on an existing repo (auto-detected when the repo has
# committed source). Creates a mill/run-<id> branch via git worktree.
mill new "refactor the auth middleware" --mode edit --pr

# Stop after a named stage so you can review before paying for the rest.
# Resume with `mill run <id>` to continue.
mill new "..." --stop-after design

# Resume a partially-completed run (crash recovery, or after --stop-after)
mill run <run-id>

# Inspect state
mill status [<run-id>]
mill tail   <run-id> --follow   # human-readable activity stream
mill logs   <run-id> --follow   # raw events
mill kill   <run-id>

# Cross-run memory
mill history                    # print .mill/journal.md
mill findings                   # recurring findings across runs
mill findings suppress <fp>     # silence a known false positive
mill onboard                    # profile the repo for future runs

# Long-running worker that picks up queued runs (from the mill checkout)
npm run worker
```

## How it works

Each pipeline stage calls `runClaude()` in `src/orchestrator/claude-cli.ts`,
which `spawn`s the `claude` binary with flags for that stage:

- `--max-budget-usd <n>` caps cost per invocation (no in-harness token math).
- `--json-schema <schema>` forces structured output from clarify, design-ui,
  verify, and the critics. We pass a zod schema converted to JSON Schema.
- `--resume <session-id>` keeps the implementer's session across review
  iterations; each critic resumes its own session. IDs are stored in SQLite.
- `--allowedTools` / `--disallowedTools` scope what each stage can do. The
  implementer gets full edit power inside its workdir; critics are read-only.
- `--setting-sources project,user` tells Claude Code to pick up our per-run
  `.claude/settings.json` (the sandbox hook) plus the user's global config
  (MCP servers like Stitch / Playwright).

**Per-run sandbox.** For every run, the harness writes
`.mill/runs/<id>/.claude/settings.json` with a `PreToolUse` hook pointing at
`guard.ts`. The guard:

- rejects any tool call if `.mill/runs/<id>/KILLED` exists (`mill kill` path)
- rejects Write/Edit outside the workdir (plus stage-specific extras like
  `.mill/runs/<id>/verify/`)
- blocks `rm -rf /`, `sudo`, and related destructive commands

The harness never calls the Anthropic API itself — `claude` does. We just
orchestrate, sandbox, enforce budgets, and persist.

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
| tests | Repo's real test command from `.mill/profile.json` — non-zero exit = HIGH | Subprocess (no LLM) |
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

Three files under `.mill/` feed future runs by being auto-injected into spec
and design prompts:

- **`.mill/journal.md`** — one stanza per completed run. Activity log: what was
  asked, what shipped, cost. Written by the deliver stage.
- **`.mill/decisions.md`** — ADR-lite entries for non-obvious design
  trade-offs the run resolved. Written by the `decisions` sub-stage after
  deliver, strictly gated: each entry must cite a specific finding, spec
  criterion, or external constraint. A clean run produces zero entries.
- **`.mill/profile.json`** — one-shot repo profile (language, test command,
  conventions). Written by `mill onboard`, refreshed with `mill onboard --refresh`.

Plus the **findings ledger** — aggregated across runs from the `findings`
SQLite table. Shown by `mill findings`, and the top recurring entries are
injected into edit-mode prompts so the implementer preempts issues that
keep getting flagged on this repo.

| File | Answers | Triggered by |
|---|---|---|
| journal.md | What did mill do last time? | Every completed run |
| decisions.md | What design debates have we already resolved? | Post-deliver, only for non-obvious trade-offs |
| ledger (SQLite) | What bugs keep recurring? | Every review stage |
| profile.json | What is this repo? (language, test cmd) | `mill onboard` |

## Layout

```
src/
├── cli.ts                          # mill init|new|run|status|logs|tail|kill
│                                   # |onboard|history|findings
├── core/                           # types, SQLite store, paths, budget, logger
│   ├── journal.ts | ledger.ts | decisions.ts | profile.ts | project.ts
│   └── store.sqlite.ts
└── orchestrator/
    ├── pipeline.ts                 # stage state machine
    ├── worker.ts                   # polls SQLite for queued runs
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

.mill/                                # per-project state (gitignored)
├── project.json                    # project marker (written by mill init)
├── mill.db                 # SQLite: runs, stages, findings, sessions
├── journal.md | decisions.md       # cross-run memory
├── profile.json                    # repo profile (mill onboard)
└── runs/<id>/                      # per-run artifacts
    ├── .claude/settings.json       # sandbox hook config
    ├── KILLED                      # (sentinel; present if `mill kill`ed)
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
| `MILL_BUDGET_USD_PER_RUN` | 20 | Hard cap on cumulative cost per run |
| `MILL_BUDGET_USD_PER_STAGE` | 5 | Passed to each `claude` as `--max-budget-usd` |
| `MILL_TIMEOUT_SEC_PER_RUN` | 3600 | Wall-clock cap per run |
| `MILL_TIMEOUT_SEC_PER_STAGE` | 600 | Wall-clock cap per stage |
| `MILL_MAX_REVIEW_ITERS` | 3 | implement ⇄ review loop cap |
| `MILL_MAX_CONCURRENT_RUNS` | 2 | Worker concurrency |
| `MILL_MODEL` | (claude default) | Pass to every `claude` invocation |
| `MILL_ROOT` | cwd | Project root (for worker processes running elsewhere) |
| `MILL_ADVERSARIAL_REVIEW` | auto | `auto` \| `on` \| `off` — optional Codex critic |
| `MILL_TESTS_CRITIC` | auto | `auto` \| `on` \| `off` — mechanical test critic |
| `MILL_SPEC2TESTS` | auto | `auto` \| `on` \| `off` — generate test scaffolds from spec |
| `MILL_CODEX_COMPANION` | (auto-discover) | Absolute path to `codex-companion.mjs` |

## License

MIT — see [LICENSE](./LICENSE).
