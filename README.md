# dark-factory

A command-line harness around the `claude` CLI. Feed it a requirement, answer
one batch of clarifying questions, and the pipeline runs dark — spec, design,
implement, review, verify, deliver — spawning `claude` subprocesses at each
stage and logging everything to SQLite.

```
intake → clarify → [USER: answer] → spec
                   ↓ (dark from here)
design → implement → review ⇄ implement (≤3 iters) → verify → deliver
```

## Setup

```sh
# 1. Claude Code itself
npm i -g @anthropic-ai/claude-code
claude --version        # sanity

# 2. dark-factory
npm install             # better-sqlite3 builds natively
npm run build           # compiles src/ → dist/ + copies prompts
```

Requires Node ≥ 22. No `ANTHROPIC_API_KEY` needed here — `claude` handles auth
via its own login flow (API key, Pro/Max subscription, or workspace).

## Usage

```sh
# Start a run. Prompts clarifying questions inline, then runs dark.
npm run df -- new "TypeScript CLI that converts markdown to minified HTML"

# Resume a partially-completed run (crash recovery)
npm run df -- run <run-id>

# Inspect state
npm run df -- status [<run-id>]
npm run df -- logs   <run-id> --follow
npm run df -- kill   <run-id>

# Run the worker (picks up queued runs from SQLite)
npm run worker
```

## How it works

Each pipeline stage calls `runClaude()` in `src/orchestrator/claude-cli.ts`,
which `spawn`s the `claude` binary with flags for that stage:

- `--max-budget-usd <n>` caps cost per invocation (no in-harness token math).
- `--json-schema <schema>` forces structured output from clarify, design-ui,
  verify, and the three critics — we pass a zod schema converted to JSON
  Schema.
- `--resume <session-id>` keeps the implementer's session across review
  iterations, and each critic its own session. IDs are stored in SQLite.
- `--allowedTools` / `--disallowedTools` scope what each stage can do. The
  implementer gets full edit power inside its workdir; critics are read-only.
- `--setting-sources project,user` tells Claude Code to pick up our per-run
  `.claude/settings.json` (the sandbox hook) plus the user's global config
  (for MCP servers like Stitch / Playwright).

Per-run sandbox: for every run, the harness writes
`runs/<id>/.claude/settings.json` with a `PreToolUse` hook pointing at
`guard.ts`. The guard:

- rejects any tool call if `runs/<id>/KILLED` exists (`df kill` path)
- rejects Write/Edit outside `runs/<id>/workdir/` (plus any stage-specific
  extra dirs like `runs/<id>/verify/`)
- blocks `rm -rf /`, `sudo`, and related destructive commands

The harness never calls the Anthropic API itself — `claude` does. We just
orchestrate and persist.

### Optional: adversarial review via Codex

If the [Codex Claude Code plugin](https://github.com/openai/codex) is
installed and the `codex` CLI is authed, the review stage adds a fourth
critic backed by `/codex:adversarial-review` (a second-opinion pass from
an independent model that challenges the chosen approach, not just
checks for defects). It runs alongside security/correctness/ux against
the cumulative diff from `impl/iter-0` and feeds findings into the same
implement⇄review loop.

To enable: `/plugin marketplace add openai/codex` then `/plugin install
codex@openai-codex` in Claude Code, and `!codex login`. Auto-detects by
default; set `DF_ADVERSARIAL_REVIEW=off` to disable, or `=on` to require
it (stage fails if unavailable). No behavior change when the plugin is
absent.

## Layout

```
src/
├── cli.ts                          # df new | run | status | logs | kill
├── core/                           # types, SQLite store, paths, budget, logger
└── orchestrator/
    ├── pipeline.ts                 # stage state machine
    ├── worker.ts                   # polls SQLite for queued runs
    ├── claude-cli.ts               # `claude` subprocess runner
    ├── guard.ts                    # PreToolUse hook binary
    ├── run-settings.ts             # writes per-run .claude/settings.json
    ├── context.ts / config.ts / git.ts / prompts.ts
    ├── stages/*.ts                 # clarify, spec, design(.ui|.arch),
    │                               # implement, review, verify, deliver
    └── critics/*.ts                # security, correctness, ux

src/prompts/*.md                    # 9 system prompts, iterable without rebuild
runs/<id>/                          # per-run artifacts (gitignored)
```

## Environment

See `.env.example`. Relevant knobs:

| Var | Default | Purpose |
|---|---|---|
| `DF_BUDGET_USD_PER_RUN` | 20 | hard cap on cumulative cost per run |
| `DF_BUDGET_USD_PER_STAGE` | 5 | passed to each `claude` as `--max-budget-usd` |
| `DF_MAX_REVIEW_ITERS` | 3 | implement ⇄ review loop cap |
| `DF_MODEL` | (claude default) | pass to every `claude` invocation |
| `DF_ROOT` | cwd | where `runs/` lives |

## Design

- Request flow (end-to-end): see the plan at
  `/Users/bryce/.claude/plans/reflective-churning-wigderson.md`.
- Review loop termination, critic parallelism, stage contracts: see the
  prompts under `src/prompts/`.
