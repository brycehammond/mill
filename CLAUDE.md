# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mill` is a Node/TypeScript harness that `spawn`s the `claude` CLI for each pipeline stage (spec → design → (spec2tests?) → implement ⇄ review → verify → deliver → decisions). The binary is `mill`. The harness does **not** call the Anthropic API directly — `claude` does. Our job is orchestration, sandboxing, budget/kill enforcement, and SQLite persistence. `README.md` has the user-facing tour; this file is for contributors.

## Commands

```sh
npm run mill -- init           # one-time: create .mill/ at the git repo root
npm run mill -- new "..."      # start a new run (prompts for clarifications inline)
npm run mill -- run <run-id>   # resume a partially-completed run
npm run mill -- status [id]    # inspect state
npm run mill -- tail <id>      # human-readable activity stream
npm run mill -- logs <id>      # raw events
npm run mill -- kill <id>      # writes .mill/runs/<id>/KILLED sentinel
npm run mill -- onboard        # one-shot repo profile → .mill/profile.json
npm run mill -- findings       # recurring findings across runs (ledger)
npm run mill -- history        # print .mill/journal.md
npm run worker               # long-running process that picks up queued runs

npm run typecheck            # tsc --noEmit
npm test                     # node test runner via tsx (src/**/*.test.ts)
npm run build                # tsc + cp -r src/prompts dist/prompts (clean first!)
npm run clean                # rm -rf dist
```

The `build` target's `cp -r src/prompts dist/prompts` fails if `dist/prompts` already exists (macOS cp copies *into* rather than replacing). Always `npm run clean && npm run build` for a full build.

`npm test` runs Node's built-in test runner under `tsx` with no extra deps. Coverage is intentionally pure-function-shaped — the harness `spawn`s `claude`, so end-to-end tests would require live API calls. Today's suites: `core/costs.test.ts` (cost tally), `core/types.test.ts` (severity ordering, finding fingerprint), `core/store.sqlite.test.ts` (SQLite round-trip via `:memory:`), `orchestrator/claude-cli.test.ts` (JSON / markdown extractors and `pickStructured`), `orchestrator/stages/review.test.ts` (`shouldStopReviewLoop`). When you add a new pure helper or load-bearing invariant, add a test next to it (`*.test.ts` colocated).

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

`run-settings.ts` writes `.mill/runs/<id>/workdir/.claude/settings.json` with a `PreToolUse` hook pointing at `guard.ts` (dev: `tsx guard.ts`; prod: `node guard.js`, toggled by `isSourceMode`). Two things about this are easy to miss:

- Claude Code's `--setting-sources project` reads `.claude/settings.json` from **cwd only**, not walking up. The file must live in the workdir, not in a parent. (Verified against claude 2.1.117 on 2026-04-22.)
- `guard.ts` runs **on every tool call** of every `claude` subprocess. Keep it dependency-free — no imports from `src/core/`. It reads state from env vars (`MILL_RUN_KILLED`, `MILL_WORKDIR`, `MILL_EXTRA_WRITE_DIRS`, `MILL_RUN_ID`) set by `claude-cli.ts`. It must fail open on parse/IO errors so a bug in the hook can't brick Claude Code itself.

Stages that legitimately write outside the workdir (e.g. verify writes into `.mill/runs/<id>/verify/`) declare those paths via `extraWriteDirs`, which becomes `MILL_EXTRA_WRITE_DIRS` (colon-separated).

### Two layers of command restriction

Destructive-command blocking (`sudo`, `rm -rf /`, fork bomb) lives **only** in `permissions.deny` inside the per-run `settings.json` — not in `guard.ts`. The guard used to duplicate these with regex, but the sudo word-boundary pattern produced false positives (e.g. `echo "use sudo"` would get blocked). Keep the guard focused on state-dependent checks (`KILLED` sentinel, dynamic write-dir allow-list) that settings can't express, and add new static command bans to `run-settings.ts::permissions.deny` only.

## MCPs without user hooks

UI stages (design-ui, verify for kind=ui) need user-level MCP servers like Stitch and Playwright, but pulling them in via `settingSources: ["user", "project"]` would also drag in the user's global `UserPromptSubmit`/`Stop`/`PostToolUse` hooks — potentially exfiltrating run data to the user's Slack/webhook integrations. Instead, these stages pass `inheritUserMcps: true` to `runClaude`, which loads **both** `~/.claude/settings.json` and `~/.claude.json` (every one that exists) via repeated `--mcp-config` + `--strict-mcp-config`. Both files must be passed because Claude Code writes MCPs to either location depending on how they were installed, and users frequently have servers split across both (e.g. figma in `settings.json`, stitch/blender in `.claude.json`) — picking only the first file made MCPs from the other silently invisible. Only the `mcpServers` field is consumed from each; hooks in the same files are ignored. `MILL_USER_MCP_CONFIG` overrides to a single explicit file.

## Session slots

Each stage persists a `session_id` via `store.saveSession(runId, slot, ...)`. Slots are logical strings: stage names (`implement`, `verify`, `decisions`) and sub-keys for critics (`review:security`, `review:ux`, etc.). The implementer resumes across review iterations with `--resume <implement-session-id>` so it keeps context. Critics each resume their own session so their prior reasoning carries forward iteration to iteration.

## Cross-run memory

Three files at the project root under `.mill/` accumulate state that future runs auto-inject into their prompts. When adding a new stage that takes spec/design as input, match the existing pattern: read these (via `readJournalTail`, `readDecisionsTail`, `renderLedgerHint`) and prepend to the prompt body.

- **`.mill/journal.md`** — one stanza per completed run. Written by `stages/deliver.ts`. Entries are `\n---\n`-delimited. A write failure is caught and logged but does not fail the run.
- **`.mill/decisions.md`** — ADR-lite trade-off log. Written by `stages/decisions.ts` post-deliver, strictly gated (must cite a finding fingerprint, spec criterion, or external constraint — zero entries is the common case). Same delimiter convention.
- **findings ledger** — aggregated from the `findings` SQLite table via `store.listLedgerEntries(...)` and rendered by `core/ledger.ts::renderLedgerHint`. Edit-mode only — surfaces recurring issues so the implementer preempts them.
- **`.mill/profile.json`** — repo profile written by `mill onboard` (`orchestrator/onboard.ts`). Not per-run; refresh with `mill onboard --refresh`. Rendered into prompts via `readProfileSummary`.

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

## New-mode workdir promotion

Edit-mode runs commit onto a fresh `mill/<slug>-<shortId>` branch via `git worktree add` (in `stages/intake.ts`). The slug is derived from the requirement text via `slugifyRequirement` (`core/slug.ts`) — biographical preambles ("I am a…", "As a…") are skipped in favor of the next sentence; stop words filtered; truncated to 40 chars at a word boundary. The 4-char shortId (last 4 chars of the run id) keeps two runs with similar intents from colliding. Falls back to `mill/run-<runId>` only when the requirement degenerates to all stop words. Result: branches show up in `git branch -a` as `mill/add-dark-mode-toggle-settings-page-sa2n` instead of `mill/run-20260424-140852-sa2n`. New-mode runs build into `.mill/runs/<id>/workdir/` with a self-contained git history — useful for sandboxing and parallel runs, but the result is invisible to anyone looking at the project root. After a clean delivery (verify pass + zero unresolved HIGH+), `deliver.ts` calls `promoteWorkdir` (`orchestrator/promote.ts`) to copy the workdir contents up into `ctx.root`. Two non-obvious rules: (1) `.git/` is skipped — copying it would destroy the parent's repo. The workdir's git history stays accessible at `.mill/runs/<id>/workdir/.git/` for users who want to cherry-pick it. (2) `.gitignore` is *merged*, not overwritten — the workdir's language-specific rules (`.build/`, `.swiftpm/`, …) are preserved alongside the `/.mill/` rule that `mill init` lays down. `MILL_PROMOTE_NEW_WORKDIR=auto|on|off` gates: `auto` skips when the parent root has user content beyond `{.git, .gitignore, .mill}` (don't silently overwrite); `on` always promotes; `off` never. Failures are logged + eventized (`workdir_promoted` / `workdir_promote_failed`) but never fail the run — the workdir is the source of truth either way.

## Environment knobs

All config is env-driven via `orchestrator/config.ts`. Defaults live there. `.env.example` documents them. `MILL_ROOT` controls where `.mill/` is discovered from — important if you run the worker from a different cwd than the checkout. Other sub-stage gates: `MILL_ADVERSARIAL_REVIEW`, `MILL_TESTS_CRITIC`, `MILL_SPEC2TESTS`, `MILL_AGENT_TEAMS` — all accept `auto|on|off`, where `on` turns a missing dependency (or in the teams case, a failure) into a hard failure rather than a skip/fallback. `MILL_PROMOTE_NEW_WORKDIR=auto|on|off` gates new-mode workdir promotion (see above). `MILL_USER_MCP_CONFIG` overrides the paths mill reads MCPs from when `inheritUserMcps: true` is passed, collapsing the default two-file load to the single file specified. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are scrubbed from the `claude` subprocess env so a key in the parent shell can't silently flip billing to API mode.
