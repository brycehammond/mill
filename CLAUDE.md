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
npm run build                # tsc + cp -r src/prompts dist/prompts (clean first!)
npm run clean                # rm -rf dist
```

The `build` target's `cp -r src/prompts dist/prompts` fails if `dist/prompts` already exists (macOS cp copies *into* rather than replacing). Always `npm run clean && npm run build` for a full build.

There is no test runner yet. `npm run typecheck` is the verification pass.

## Import extension rule

`tsconfig.json` uses `"module": "ESNext"` with `"moduleResolution": "Bundler"`, and we ship ESM. **Every relative import of a `.ts` file must be written with a `.js` extension** (e.g. `import { ... } from "../core/index.js"`). `tsx` resolves this in dev; `tsc` emits `.js` in `dist/`. Do not add new imports without the `.js` suffix — it will break the compiled build even if it "works" under `tsx`.

`noUncheckedIndexedAccess` is on. Non-null assertions like `names[i]!` after a parallel `settled.forEach(...)` are intentional; don't "fix" them by guarding, because the loop index is a bounded parallel array.

## Pipeline execution model

`src/orchestrator/pipeline.ts` is the driver. Four properties are load-bearing:

1. **Crash recovery is stage-idempotent.** `needsStage(ctx, name)` checks `store.getStage(...).status === "completed"` and skips. The CLI can invoke `mill run <id>` at any point and the pipeline picks up where it left off. New stages must persist completion through `store.finishStage(...)` or they will rerun forever on resume.

2. **Stage finalization is transactional.** Cost tally (`addRunCost`), session id (`saveSession`), and `finishStage` must commit together via `store.transaction(() => { ... })`. A crash between these calls on resume would double-bill or lose the session id. `claude-cli.ts` adds cost to the in-memory `BudgetTracker` but deliberately does *not* touch the DB — that's the caller's responsibility inside the transaction.

3. **Kill is checked in two places.** The `KILLED` sentinel file is checked (a) by the `PreToolUse` guard hook on every tool call inside `claude`, and (b) by `throwIfKilledOrBroken` after each stage in the pipeline. Both checks must remain; the hook blocks in-flight tool use, the pipeline check unwinds the stack cleanly via `KilledError`.

4. **Post-deliver stages are best-effort.** `decisions` runs after `deliver`, which has already set the run to `completed|failed`. A failure inside `decisions` must *not* flip that outcome — it catches its own errors, writes a stage row so resume doesn't loop, and returns `ok: true`. Any future post-deliver stage must follow the same pattern.

## Review loop termination

`shouldStopReviewLoop` in `stages/review.ts` stops on any of: max iterations, zero HIGH+ findings, or current HIGH findings are a subset of the previous iteration's (the "stuck" signal). Subset test uses `findingFingerprint(f) = critic|severity|title.toLowerCase()` — the canonical fingerprint is defined in `core/types.ts` and shared by stuck-detection, the cross-run ledger, and the suppression list. If you add critic fields that affect dedup, update it there (and migrate existing rows).

Critics run via `Promise.allSettled` — one critic crashing does not kill the review; it's logged and the stage is marked failed while still producing a findings report. There are five critics, not all LLM-backed:

- `security`, `correctness`, `ux` — Claude, read-only (`Read`/`Glob`/`Grep`/`Bash`), routed through `critics/shared.ts::runCritic`.
- `tests` — **mechanical**. Runs `.mill/profile.json`'s test command as a subprocess; non-zero exit → HIGH finding. Auto-off if the profile lacks a test command. Same `CriticResult` contract so `review.ts` aggregates it uniformly.
- `adversarial` — optional, gated on `MILL_ADVERSARIAL_REVIEW=auto|on|off` plus both the Codex plugin and the `codex` CLI being available. Billing is on the codex side and usage is reported as zero in `TokenUsage`.

### Team-mode review (MILL_AGENT_TEAMS)

The three LLM critics (`security`, `correctness`, `ux`) have a second execution path: one `claude` subprocess plays "review lead," calls `TeamCreate`, and spawns each critic as a teammate via `Agent(team_name=..., subagent_type="security"|...)`. Teammates share session state and can cross-reference each other's findings mid-work via `SendMessage` — the per-subprocess path can't. `critics/team-review.ts` drives this; `prompts/review-lead.md` is the lead persona; `prompts/critic-*.md` are pushed into the session as custom subagents via the `--agents <json>` CLI flag (the JSON rejects `tools` as a comma-string — must be an array).

`MILL_AGENT_TEAMS=auto|on|off` picks the path. `auto` (default) tries team mode and quietly falls back to `Promise.allSettled([securityCritic, correctnessCritic, uxCritic])` on any failure. `on` hard-fails the review stage if team mode errors. `off` skips team mode entirely. `tests` and `adversarial` never go through the team — `tests` is mechanical and `adversarial` is codex-backed.

Two capability trade-offs to know about:
1. **Session slots collapse.** Per-subprocess mode persists `review:security`, `review:correctness`, `review:ux` so each critic resumes iteration-to-iteration. Team mode persists a single `review:lead` slot; the lead carries prior-iteration context and re-briefs fresh critics each time. Keep this in mind if you add a new slot key — don't assume per-critic resume exists in team mode.
2. **Per-critic cost attribution is lost.** The lead subprocess emits one `total_cost_usd` covering itself + the three critics. Run-level cost is still correct; per-critic cost reporting (tail/status) shows it all under the lead session. Document any new per-critic cost metric as "subprocess-path-only."

## Structured output from `claude`

Stages that need JSON pass a `jsonSchema` (zod → `zod-to-json-schema`) to `runClaude`. Read the result with `pickStructured(result)`, not `JSON.parse(result.text)`. `pickStructured` prefers `result.structuredOutput` (the parser built into Claude Code), falls back to `extractJsonBlock`, and surfaces non-success subtypes (`error_max_turns`, `error_during_execution`, `error_budget`) as errors instead of masking them as parse failures.

## Per-run sandbox

`run-settings.ts` writes `.mill/runs/<id>/workdir/.claude/settings.json` with a `PreToolUse` hook pointing at `guard.ts` (dev: `tsx guard.ts`; prod: `node guard.js`, toggled by `isSourceMode`). Two things about this are easy to miss:

- Claude Code's `--setting-sources project` reads `.claude/settings.json` from **cwd only**, not walking up. The file must live in the workdir, not in a parent. (Verified against claude 2.1.117 on 2026-04-22.)
- `guard.ts` runs **on every tool call** of every `claude` subprocess. Keep it dependency-free — no imports from `src/core/`. It reads state from env vars (`MILL_RUN_KILLED`, `MILL_WORKDIR`, `MILL_EXTRA_WRITE_DIRS`, `MILL_RUN_ID`) set by `claude-cli.ts`. It must fail open on parse/IO errors so a bug in the hook can't brick Claude Code itself.

Stages that legitimately write outside the workdir (e.g. verify writes into `.mill/runs/<id>/verify/`) declare those paths via `extraWriteDirs`, which becomes `MILL_EXTRA_WRITE_DIRS` (colon-separated).

### Two layers of command restriction

Destructive-command blocking (`sudo`, `rm -rf /`, fork bomb) lives **only** in `permissions.deny` inside the per-run `settings.json` — not in `guard.ts`. The guard used to duplicate these with regex, but the sudo word-boundary pattern produced false positives (e.g. `echo "use sudo"` would get blocked). Keep the guard focused on state-dependent checks (`KILLED` sentinel, dynamic write-dir allow-list) that settings can't express, and add new static command bans to `run-settings.ts::permissions.deny` only.

## MCPs without user hooks

UI stages (design-ui, verify for kind=ui) need user-level MCP servers like Stitch and Playwright, but pulling them in via `settingSources: ["user", "project"]` would also drag in the user's global `UserPromptSubmit`/`Stop`/`PostToolUse` hooks — potentially exfiltrating run data to the user's Slack/webhook integrations. Instead, these stages pass `inheritUserMcps: true` to `runClaude`, which loads `~/.claude/settings.json` (or `~/.claude.json`) via `--mcp-config` + `--strict-mcp-config`. Only the `mcpServers` field is consumed; hooks in the same file are ignored. Override the source path with `MILL_USER_MCP_CONFIG`.

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

## Environment knobs

All config is env-driven via `orchestrator/config.ts`. Defaults live there. `.env.example` documents them. `MILL_ROOT` controls where `.mill/` is discovered from — important if you run the worker from a different cwd than the checkout. Other sub-stage gates: `MILL_ADVERSARIAL_REVIEW`, `MILL_TESTS_CRITIC`, `MILL_SPEC2TESTS`, `MILL_AGENT_TEAMS` — all accept `auto|on|off`, where `on` turns a missing dependency (or in the teams case, a failure) into a hard failure rather than a skip/fallback. `MILL_USER_MCP_CONFIG` overrides the path mill reads MCPs from when `inheritUserMcps: true` is passed.
