# Dark Factory — Implementation Plan (refined)

## Context

Greenfield build at `./` (the repo root). Goal: a "dark factory for software" — an
autonomous agentic pipeline that takes a requirement, asks a single batch of
clarifying questions up front, then runs unattended to produce a reviewed,
verified software artifact. The user sees the work only at intake (answering
clarifications) and at delivery. Phase 2 adds a web UI for watching runs live.

### Invariants (do not violate)

1. **One user touchpoint per run.** After clarifying answers are submitted, no
   stage prompts the user for anything. All escalations land in `delivery.md`.
2. **Orchestrator is the sole writer to SQLite.** Everything else reads.
3. **Stages are idempotent on re-run.** A crash mid-stage must be recoverable
   by rerunning the stage from its last checkpoint without corrupting the
   workdir.
4. **The workdir is the boundary.** No stage except `deliver` writes outside
   `runs/<id>/`.

### Confirmed intent

- Refinement: one-shot Q&A at intake, dark thereafter.
- Runtime: TypeScript + Claude Agent SDK.
- Sandbox: per-run workdir + tool allowlist. No Docker for MVP.
- MVP output kinds: CLI, backend/API, web UI.

## Architecture

### Pipeline

```
intake → clarify → [USER: answers] → spec
                                      ↓  (dark from here)
                     design → implement → review ⇄ implement (≤3) → verify → deliver
```

Stage contracts:

| Stage     | Kind   | Budget (USD) | Wall-clock | Writes to                          |
|-----------|--------|--------------|------------|------------------------------------|
| intake    | sync   | 0            | instant    | `requirement.md`, DB row           |
| clarify   | agent  | 1            | 60s        | `clarifications.json` (questions)  |
| spec      | agent  | 2            | 60s        | `spec.md`, `verification_plan.json`|
| design    | agent  | 2            | 3min       | `design/`                          |
| implement | agent  | 5 / iter     | 15min      | `workdir/` (git, branch per iter)  |
| review    | agent  | 10 total     | 5min       | `reviews/<iter>/`                  |
| verify    | sync   | 0            | 5min       | `verify/`                          |
| deliver   | sync   | 0            | instant    | `delivery.md`, `delivery.json`     |

**Run defaults:** $20 total, 60min total, 1 concurrent run (MVP). Raise to 2
after first clean weekend of runs.

### Stages in detail

- **intake (sync).** CLI accepts requirement text only. Writes `requirement.md`
  and inserts `runs` row with `status='queued_clarify'`. Attachments are out of
  scope for MVP.
- **clarify (agent, ≤60s).** One Claude call returns structured JSON:
  ```json
  {
    "kind": "ui | backend | cli | unclear",
    "kind_confidence": 0.0,
    "questions": [
      {"id": "q1", "text": "...", "why": "...", "default": "..."}
    ]
  }
  ```
  `questions` may be empty. CLI prompts inline, captures answers into
  `clarifications.json`, and sets status to `queued` so the worker picks it up.
  The answers payload may override `kind` — use that as ground truth.
- **spec (agent, ≤60s).** Synthesizes `spec.md` with required sections
  (`goal`, `non_goals`, `acceptance_criteria`, `constraints`,
  `interface`). Also emits `verification_plan.json`:
  ```json
  {
    "kind": "cli | backend | ui",
    "checks": [
      {"id": "c1", "type": "cli_invoke", "args": [...], "stdin": "...", "assert_stdout_contains": "..."},
      {"id": "c2", "type": "http", "method": "GET", "path": "/todos", "expect_status": 200},
      {"id": "c3", "type": "playwright_smoke", "url": "/", "expect_no_console_errors": true}
    ]
  }
  ```
  Downstream stages read the spec, not the original requirement.
- **design (agent, ≤3min).** For `kind==='ui'`: Stitch MCP
  (`generate_screen_from_text` then optional `edit_screens`), drops URL +
  screenshots + `design_intent.md` in `design/`. For `backend|cli`: emits
  `architecture.md` via plain Claude. **Fallback:** if Stitch MCP is
  unreachable, degrade UI to the architecture path and note it in
  `design_intent.md`. No design iteration in MVP.
- **implement (agent, ≤15min, git-tracked).** Fresh `git init` in
  `runs/<id>/workdir/`. SDK `query()` with `permissionMode: 'bypassPermissions'`,
  `cwd` pinned to the workdir, full Claude Code tools + Stitch MCP (UI kind
  only). Commits to `impl/iter-N` on success. On re-run after crash: `git reset
  --hard impl/iter-(N-1)` (or empty tree if iter 1) before the new attempt.
- **review (3 critics in parallel).** `security`, `correctness`, `ux`. Each is
  a read-only `query()` with tools restricted to `Read`, `Glob`, `Grep`,
  `Bash(cat:*|rg:*|ls:*)`. Returns structured JSON findings:
  ```json
  {"severity": "HIGH|MED|LOW", "title": "...", "file": "...", "line": 0,
   "evidence": "...", "suggested_fix": "..."}
  ```
  Aggregated report is fed back to the implementer with its session resumed.
  Critics' sessions persist across iterations so they can remember prior calls
  (cheap context continuity; capped by the iteration termination rule below).
- **Review loop termination.** Any one fires:
  1. 3 iterations reached.
  2. Zero findings at severity ≥ HIGH.
  3. **"Stuck"**: the set of HIGH fingerprints in iter N is a subset of iter
     N-1's. Fingerprint = `sha1(critic | severity | normalizedTitle | filePath)`
     where `normalizedTitle` is lowercased, whitespace-collapsed, trailing
     punctuation stripped.
  4. Run-total budget or wall-clock exhausted.
  In all four cases the pipeline proceeds to verify → deliver. Unresolved HIGH
  findings are listed in `delivery.md` (invariant 1: no user escalation
  mid-run).
- **verify (≤5min).** Reads `verification_plan.json`. Dispatches per check
  type:
  - `cli_invoke`: shell out, capture stdout/stderr, assert.
  - `http`: spawn server with `bun run start` on an ephemeral port, wait for
    `GET /` or a configured health path (30s timeout), curl each endpoint,
    teardown.
  - `playwright_smoke`: build the app (`bun run build`), preview server on
    ephemeral port, Playwright navigates, collects console errors, takes a
    screenshot.
  Writes per-check results to `verify/verification.json` and `verify/<id>.log`.
- **deliver (sync).** Emits `delivery.md` (human-readable) and
  `delivery.json` (Phase-2 UI-parseable) with: total cost, wall-clock, final
  iteration count, resolved/unresolved HIGH findings, verify outcomes,
  artifact pointers.

### Kill-switch (dual mechanism)

1. **AbortController** passed to every `query()` via `options.abortSignal`.
   SIGTERM to the worker aborts the in-flight stage.
2. **Sentinel file + PreToolUse hook.** `runs/<id>/KILLED` on disk; a
   `PreToolUse` hook (passed to the SDK via `options.hooks`, not via
   `.claude/settings.json`) checks for it before every tool call and vetoes.
   Needed because a sentinel alone misses think-only turns, and an abort alone
   is racy against long tool calls.

Both must fire on kill. Hooks via SDK options, not the repo-root settings
file — settings discovery from `cwd: runs/<id>/workdir/` is fragile and not
worth debugging.

## Runtime choices

- **Language & runtime:** TypeScript on **Bun** (fast start, native SQLite via
  `bun:sqlite`, native TS). No `better-sqlite3` — that was an inconsistency
  in the draft.
- **Agent framework:** `@anthropic-ai/claude-agent-sdk`. Fresh `query()` per
  stage call. Sessions: implement + each critic persist their `session_id`
  across iterations; all other stages are one-shot.
- **Orchestrator:** async state machine in
  `packages/orchestrator/src/pipeline.ts`. Each stage is `(ctx: RunContext) =>
  Promise<StageResult>`. Crash-resumable via per-stage checkpoints.
- **State store:** SQLite (WAL) + filesystem. Single writer = orchestrator.
- **Worker handoff:** status machine
  `queued_clarify → awaiting_answers → queued → running → done|failed`. The
  worker polls for `status='queued'`. The CLI owns `queued_clarify` and
  `awaiting_answers`.

### Sandbox / safety

- Implementer Bash allowlist restricts paths to the workdir via the
  `PreToolUse` hook (rejects paths outside `runs/<id>/workdir/`, rejects `..`
  escapes).
- Critics are read-only (no `Edit`, `Write`, `Bash(rm:*|mv:*|…)`).
- No network tools for critics beyond `WebFetch` (read-only anyway).
- `deliver` is the only stage allowed to touch outside the workdir.

## MVP scope (1 week, vertical-slice ordering)

Goal: working E2E pipeline with stubs by end of Day 3; swap stubs for real
agents Days 4–6; polish Day 7.

| Day | Deliverable                                                                                                                              |
|-----|------------------------------------------------------------------------------------------------------------------------------------------|
| 1   | Repo skeleton, `packages/core` types + SQLite store + paths helpers, `df` CLI scaffolding (`df new`, `df status`, `df logs`, `df kill`). |
| 2   | `intake` + `clarify` stages (CLI prompts inline, captures answers, enqueues to worker).                                                  |
| 3   | `spec` (with `verification_plan.json`) + `design.arch` branch. **Stub implement/review/verify** so `df new "hello world CLI"` runs E2E.  |
| 4   | Real `implement` stage — SDK `query()`, session persistence, git commits per iteration, hook-based path sandbox.                         |
| 5   | Real `review` stage — 3 parallel critics, fingerprint termination rule, iteration loop.                                                  |
| 6   | Real `verify` (all three check types) + `deliver` (md + json). `design.ui` via Stitch.                                                   |
| 7   | Run the three acceptance cases below; fix fallout. One stretch run of the UI case twice for variance check.                              |

### Explicitly out of scope for MVP

Web UI, Figma MCP, Docker sandbox, Inngest/Temporal migration, meta-critic,
performance/edge-case critics, concurrency > 1, auth, image/link intake,
design iteration loop, "keep best iteration" rollback.

## Phase 2 (web UI)

Next.js in `apps/web/` reading the same SQLite DB. Dashboard + run detail +
SSE live tail + new-run form. Orchestrator stays a separate long-running
worker process; the web app never executes agents directly (keeps the door
open for Inngest migration).

Kill from UI needs an HTTP control channel or a `runs.control` column the
worker polls. Decide at Phase-2 kickoff.

## Repo layout

```
./
├── package.json                       # workspaces: packages/*, apps/*
├── tsconfig.json
├── bun.lockb
├── .env.example                       # ANTHROPIC_API_KEY, STITCH_*, DF_BUDGET_USD, ...
├── README.md
├── PLAN.md                            # this file
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── types.ts               # RunContext, StageResult, Finding, Severity, Kind
│   │   │   ├── store.ts               # StateStore interface
│   │   │   ├── store.sqlite.ts        # bun:sqlite impl (WAL, single writer)
│   │   │   ├── paths.ts               # runDir, workdir, designDir, reviewDir
│   │   │   ├── fingerprint.ts         # finding fingerprint for termination rule
│   │   │   └── budget.ts              # cost tally + kill-sentinel check
│   │   └── package.json
│   ├── orchestrator/
│   │   ├── src/
│   │   │   ├── pipeline.ts            # state machine + resume logic
│   │   │   ├── worker.ts              # polls SQLite for status='queued'
│   │   │   ├── sdk.ts                 # query() wrapper: hooks, abort, cost tally
│   │   │   ├── stages/
│   │   │   │   ├── intake.ts
│   │   │   │   ├── clarify.ts
│   │   │   │   ├── spec.ts
│   │   │   │   ├── design.ts
│   │   │   │   ├── design.ui.ts
│   │   │   │   ├── design.arch.ts
│   │   │   │   ├── implement.ts
│   │   │   │   ├── review.ts
│   │   │   │   ├── verify.ts
│   │   │   │   └── deliver.ts
│   │   │   ├── critics/
│   │   │   │   ├── security.ts
│   │   │   │   ├── correctness.ts
│   │   │   │   └── ux.ts
│   │   │   └── prompts/               # system prompts as .md (read at runtime)
│   │   └── package.json
│   └── cli/
│       └── src/index.ts               # df new | status | logs | kill
├── apps/
│   └── web/.gitkeep                   # Phase 2
└── runs/.gitkeep                      # per-run workdirs & artifacts (gitignored)
```

Per-run filesystem layout:

```
runs/<run-id>/
  requirement.md
  clarifications.json          # { questions, answers, kind_override? }
  spec.md
  verification_plan.json
  design/
    design_intent.md
    stitch_url.txt             # UI only
    screens/*.png              # UI only
    architecture.md            # backend/CLI only
  workdir/                     # git repo — branches per iteration
  reviews/<iter>/
    security.json
    correctness.json
    ux.json
    aggregate.md               # human-readable
  verify/
    verification.json
    <check-id>.log
  delivery.md
  delivery.json
  KILLED                       # sentinel (optional)
```

## Schema

```sql
runs(
  id TEXT PRIMARY KEY,
  status TEXT,                 -- queued_clarify | awaiting_answers | queued | running | done | failed
  kind TEXT,                   -- ui | backend | cli | unclear
  created_at INTEGER,
  requirement_path TEXT,
  spec_path TEXT,
  total_cost_usd REAL,
  wallclock_ms INTEGER
);

stages(
  run_id TEXT,
  name TEXT,
  iteration INTEGER DEFAULT 0,
  status TEXT,                 -- pending | running | done | failed
  started_at INTEGER,
  finished_at INTEGER,
  cost_usd REAL,
  session_id TEXT,
  artifact_path TEXT,
  error TEXT,
  PRIMARY KEY (run_id, name, iteration)
);

events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  stage TEXT,
  ts INTEGER,
  kind TEXT,                   -- message | tool_use | tool_result | cost | log
  payload_json TEXT
);

findings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  iteration INTEGER,
  critic TEXT,
  severity TEXT,               -- HIGH | MED | LOW
  title TEXT,
  fingerprint TEXT,            -- for termination rule
  file_path TEXT,
  detail_path TEXT
);

clarifications(
  run_id TEXT PRIMARY KEY,
  questions_json TEXT,
  answers_json TEXT
);
```

## Critical files

- `packages/core/src/types.ts` — `RunContext`, `StageResult`, `Finding`,
  `Severity`, `Kind` unions. Load-bearing.
- `packages/core/src/store.sqlite.ts` — single writer. Phase 2 web UI reads
  here.
- `packages/core/src/fingerprint.ts` — findings fingerprint; the termination
  rule depends on this being stable.
- `packages/orchestrator/src/pipeline.ts` — state machine + resume: on
  startup, scan `stages WHERE status='running'`, mark stale, roll workdir
  back to last committed iteration if stale stage is `implement`, resume.
- `packages/orchestrator/src/sdk.ts` — one place that wires SDK options
  (hooks, abort signal, cost tally event appending) so individual stage
  files stay thin.
- `packages/orchestrator/src/stages/implement.ts` — query invocation, session
  persistence, git commit per iteration.
- `packages/orchestrator/src/stages/review.ts` — parallel critics,
  aggregation, termination evaluator.
- `packages/orchestrator/src/prompts/*.md` — iterable without rebuild.

## Implementer stage sketch

```ts
// packages/orchestrator/src/stages/implement.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { runQuery } from "../sdk";

export async function implement(ctx: RunContext, iteration: number): Promise<StageResult> {
  await rollWorkdirToLastIteration(ctx, iteration);
  const prompt = await buildImplementerPrompt(ctx, iteration);
  const prior = await ctx.store.getSession(ctx.runId, "implement");

  const result = await runQuery(ctx, "implement", {
    prompt,
    options: {
      cwd: ctx.paths.workdir,
      permissionMode: "bypassPermissions",
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      mcpServers: ctx.kind === "ui" ? { stitch: stitchConfig } : {},
      maxBudgetUsd: 5,
      resumeSession: prior?.sessionId,
      includePartialMessages: true,
      abortSignal: ctx.abortSignal,
      hooks: ctx.hooks,         // path sandbox + kill sentinel
    },
  });

  if (!result.ok) return result;
  await gitCommit(ctx.paths.workdir, `impl/iter-${iteration}`);
  return result;
}
```

Stage files stay ≤100 lines; heavy logic lives in prompts and core helpers.
`runQuery` centralizes cost tally, event appending, and session saving so
each stage doesn't re-invent it.

## Verification — how we know v1 works

Three end-to-end acceptance runs, fully unattended after clarification
answers.

1. **CLI.** `df new "TypeScript CLI that converts markdown files to minified
   HTML. Reads filename from argv, writes to stdout."`
   Pass: `package.json` present, `bun test` exits 0, verify pipes a fixture
   markdown through the built CLI and gets valid HTML.
2. **Backend.** `df new "REST API in Node+Hono for a todo list with SQLite
   persistence. GET/POST/PATCH/DELETE /todos. README with curl examples."`
   Pass: server boots on an ephemeral port, verify curls each endpoint and
   gets 2xx, README exists with working examples.
3. **UI.** `df new "Single-page login screen: email + password, 'forgot
   password' link, validation errors, light/dark toggle."`
   Pass: Stitch design artifact exists (or degraded architecture note if
   Stitch down), workdir is a buildable Vite+React app, Playwright smoke
   navigates the built app and produces a screenshot with zero console
   errors.

For each: `delivery.md` reports total cost, wall-clock, final iteration
count, fixed HIGH findings, remaining HIGH findings (must be empty for pass),
verification outcome.

**Stretch:** run the UI case twice, diff the two workdirs. High variance =
spec isn't pinning down ambiguity; sharpen the spec-stage prompt.

## Framework testing

- **Unit:** mock the SDK via an injectable `query` function (the `sdk.ts`
  indirection makes this trivial). Test fingerprinting, termination rule,
  resume logic, verification plan dispatch.
- **Integration:** one fast path — "hello world CLI" requirement that
  bypasses clarify (pre-populated answers) and runs the full pipeline with
  real SDK calls. Budget ≤ $1. Runs in CI on demand, not per-push.

## Known tradeoffs

- **No container sandbox.** Acceptable for single-owner machine. Revisit
  before any multi-tenant exposure.
- **SQLite single-writer.** Fine for one orchestrator process. Phase 2 kill
  button needs an HTTP control channel or a `runs.control` column.
- **Claude-locked.** Switching models means rewriting stage internals.
  Acceptable given Stitch/Figma MCPs and Claude Code headless assume Claude.
- **Refinement answers are load-bearing.** Sloppy answers → sloppy spec →
  sloppy artifact. Clarifying-question quality is where prompt tuning pays
  off first.
- **Persistent critic sessions grow context.** Capped implicitly by the
  3-iteration limit; revisit if we lift that cap.
- **Fingerprint-based "stuck" rule is heuristic.** If the critic rewords a
  finding across iterations, it won't match. Acceptable; the 3-iteration
  cap is the real backstop.
