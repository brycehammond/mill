# Workflow examples

End-to-end walkthroughs of how `mill` behaves for the handful of use cases the
harness is designed around. Each example calls out **what the harness does**
(spawn subprocesses, touch SQLite, write files, gate/finalize stages) at every
stage, separately from what the `claude` subprocess is doing inside each
stage. The goal is to make it obvious where the pipeline's state lives, where
the sandbox intercepts, and how resume / kill / PR / adversarial workflows
differ.

Every example assumes `mill init` has been run in the repo so
`.mill/project.json` + `.mill/mill.db` exist.

## Contents

1. [New CLI tool from scratch](#1-new-cli-tool-from-scratch)
2. [New UI feature (Stitch-backed design)](#2-new-ui-feature-stitch-backed-design)
3. [Edit-mode refactor on an existing backend](#3-edit-mode-refactor-on-an-existing-backend)
4. [Edit-mode change with a GitHub PR](#4-edit-mode-change-with-a-github-pr)
5. [Plan-and-review: `--stop-after design`](#5-plan-and-review---stop-after-design)
6. [Kill a runaway run, resume a crashed one](#6-kill-a-runaway-run-resume-a-crashed-one)
7. [Detached run via the worker](#7-detached-run-via-the-worker)
8. [One-shot: `mill onboard`](#8-one-shot-mill-onboard)
9. [Adversarial review via the Codex plugin](#9-adversarial-review-via-the-codex-plugin)

Each walkthrough is written as **CLI invocation → pipeline timeline**. The
timeline distinguishes:

- **Harness** — code in `src/orchestrator/*` running in the `mill` CLI or
  `worker` process. Writes to SQLite, manages files, spawns `claude`.
- **Claude** — what the spawned `claude` subprocess is doing. The harness
  does **not** call the Anthropic API itself; each stage is one `spawn`.
- **Sandbox** — the `PreToolUse` guard hook inside the workdir's
  `.claude/settings.json`, which runs as a separate tiny process on every
  tool call.

---

## 1. New CLI tool from scratch

```sh
npm run mill -- new "TypeScript CLI that converts markdown to minified HTML"
```

No existing repo to touch, so the run scaffolds a fresh workdir. No git
worktree. `kind` turns out to be `cli`, the tests critic stays off (no
profile), the adversarial critic is auto-detected and typically off.

| Stage | Harness does | Claude does |
|---|---|---|
| `intake` | Creates `runs/<id>/` on disk, writes `requirement.md`, inserts the `runs` row, commits `intake` stage row. In `--mode new` there is **no** `git worktree add` — the empty workdir stays plain. | — |
| `clarify` | Loads `prompts/clarify.md`, runs `claude` with a zod→JSON schema and `allowedTools: []` (chat only). Stores the parsed `{kind, questions[]}` plus `run.kind = "cli"`. | Reads the requirement, returns up to 10 clarifying questions + classifier `kind`. |
| *(user)* | CLI prompts inline for answers; stores them via `recordAnswers`; flips `run.status = running`. | — |
| `spec` | Picks `prompts/spec.md` (new-mode variant), prepends profile/journal/decisions tail, empty ledger block (new mode), kind label. Spawns `claude` with `allowedTools: []`, 4 turns. Writes `spec.md`. | Produces `spec.md` in a single markdown block. |
| `design` | `run.kind === "cli"` → `designArchitecture`. Uses `prompts/design-arch.md`. Writes `design/architecture.md`. Stores the session id under slot `design`. | Produces `architecture.md`. |
| `spec2tests` | Gated. `MILL_SPEC2TESTS` is `auto` by default. No `.mill/profile.json` exists → harness writes a `skipped` stage row and moves on. | — |
| `implement` (iter 1) | Detects no `.git` in workdir → runs `gitInit`, `gitCommitEmpty("chore: initial empty workdir")`, tags `impl/iter-0`. Writes `runs/<id>/workdir/.claude/settings.json` with the `PreToolUse` guard hook + destructive-command deny list. Spawns `claude` with `bypassPermissions` + `settingSources: ["project"]` + `Read/Edit/Write/Bash/Glob/Grep/NotebookEdit/TodoWrite`. After the stage: `gitCommitAll`, `gitTag("impl/iter-1")`. Saves `implement` session id so iter 2+ can `--resume`. | Writes the actual code; commits logical chunks as it goes. |
| `review` (iter 1) | `Promise.allSettled` on security + correctness + ux critics. Each critic is its own `claude` subprocess with `systemPromptMode: "replace"`, read-only tools, JSON schema, its own session slot (`review:security`, etc.). Tests critic skipped (no test command). Writes `reviews/1/<critic>.md`. Each critic's findings + cost + session are committed in a transaction inside `runCritic`. | Each critic reads spec/design + workdir and returns structured findings. |
| implement⇄review loop | Harness asks `shouldStopReviewLoop` after each review: stops at 0 HIGH+ findings, at `MILL_MAX_REVIEW_ITERS` (default 3), or when the HIGH set is a subset of the previous iteration's (stuck detection, keyed on `critic\|severity\|title`). On resume, `implement` uses `--resume <prior session id>` so the implementer keeps its prior reasoning. | Implementer addresses the HIGH/CRITICAL findings; critics re-review. |
| `verify` | Writes a verify prompt with `KIND=cli` + spec. Spawns `claude` with `extraWriteDirs: [verifyDir]` (via `MILL_EXTRA_WRITE_DIRS`, read by the guard) and `addDir: [verifyDir]` (Claude Code's own access control). JSON schema forces `{pass, report_md, criteria[]}`. Stage finishes `completed` if `pass=true`, else `failed`. | Runs acceptance criteria against the workdir, writes evidence into `verify/`. |
| `deliver` | Renders `delivery.md` with stage table, token/cost totals, unresolved findings. Appends a stanza to `.mill/journal.md`. Commits `runs.status = completed\|failed` and `deliver` stage `completed` in one transaction. | — (pure harness stage, no `claude` spawn). |
| `decisions` | Best-effort: spawns `claude` read-only with the decisions prompt + findings + commit log + prior decisions tail. Appends 0–3 ADR-lite entries to `.mill/decisions.md`. Any exception is logged and swallowed — never fails the run. | Returns ≤3 structured entries, only when a spec criterion / finding / external constraint justifies one. |

**What the sandbox is doing the whole time:** every tool call inside any
`claude` subprocess hits `guard.ts`. It checks `MILL_RUN_KILLED` (absence of
the `KILLED` sentinel), whether `Write`/`Edit` targets fall inside the workdir
(plus any `extraWriteDirs`), and nothing else — destructive-command blocking
is handled by `permissions.deny` in the per-run `settings.json`, not the
guard.

---

## 2. New UI feature (Stitch-backed design)

```sh
npm run mill -- new "Dashboard with a KPI card grid and a time-series chart"
```

Clarify classifies this as `kind=ui`. The `design` stage routes to
`designUi`, which needs the user's Stitch MCP. The harness inherits MCPs
*without* inheriting user hooks — this is the "MCPs without user hooks"
posture from `CLAUDE.md`.

Differences from example 1:

| Stage | What changes for `kind=ui` |
|---|---|
| `design` | Dispatches to `designUi` (not `designArchitecture`). Spawns `claude` with `settingSources: ["project"]` + `inheritUserMcps: true` — reads `~/.claude/settings.json` (or the `MILL_USER_MCP_CONFIG` override) and exposes only its `mcpServers` field via `--mcp-config` + `--strict-mcp-config`. Tools are scoped to `mcp__stitch__*` + `Read`/`Write`. `maxTurns: 20` because Stitch generation is async (create_project → generate_screen_from_text → poll list_screens). Writes `design/design-intent.md` and `design/stitch-url.txt`. JSON schema forces `{design_intent_md, stitch_url, screens[]}`. |
| `implement` | Uses `settingSources: ["user", "project"]` *and* allows `mcp__stitch__get_screen` / `mcp__stitch__list_screens` in `allowedTools` so the implementer can re-read the Stitch output it built against. User hooks are *not* a concern at this stage — project settings take precedence for the harness-critical stuff (guard hook). |
| `verify` | `inheritUserMcps: true` because UI verification typically wants Playwright from the user's MCP config. Same hooks-free posture. |

Everything else (critics, loop, deliver, decisions) is identical to example 1.

---

## 3. Edit-mode refactor on an existing backend

```sh
# Repo has committed source — mode auto-detects as edit.
npm run mill -- new "refactor the auth middleware to use jose instead of jsonwebtoken"
```

`detectRunMode` returns `edit` because the repo has commits. This flips on
several harness behaviors simultaneously.

| Stage | Harness-specific behavior for edit mode |
|---|---|
| `intake` | **Preflights** the repo: rejects if no commits (`--mode new` required) or if the repo is mid-rebase/merge/cherry-pick/bisect. Creates the run row, then `git worktree add runs/<id>/workdir mill/run-<id> HEAD`. Configures a minimal git identity in the worktree. Tags `impl/iter-0` at the base HEAD **inside the worktree** so the adversarial critic (if enabled) has a stable diff reference from iteration 1. Records `worktree_created` event with `branch`, `baseBranch`, `baseSha`. |
| `clarify` | Identical flow; kind will typically be `backend` or `cli`. |
| `spec` | Uses `prompts/spec-edit.md` variant. Prepends **ledger hint** — recurring findings from prior runs via `store.listLedgerEntries`. Adds a `## Existing codebase` block with the workdir path. Spawns `claude` with `allowedTools: ["Read", "Glob", "Grep"]` and `maxTurns: 12` so it can actually browse the code before specifying. |
| `design` | `designArchitecture` with `prompts/design-arch-edit.md`. Same ledger + read-only tools posture. |
| `spec2tests` | Gated on `.mill/profile.json` having a test command. If present, harness spawns `claude` with `Read/Edit/Write/Glob/Grep/Bash` in the worktree, writes failing tests, then `gitCommitAll` with the `test: generate tests from spec` message. If the profile is missing and `MILL_SPEC2TESTS=on`, the stage throws — telling the user to run `mill onboard`. |
| `implement` | Workdir is the worktree (has `.git` as a gitdir pointer file, not a dir — `pathExists` via `fs.stat` handles both). `firstRun` is false → skips the empty-init-commit dance. `impl/iter-0` is already anchored by `intake`. After each iteration: `gitCommitAll` + `gitTag("impl/iter-<n>")`. If the implementer committed on its own, the harness still tags HEAD so iter tags line up. |
| `review` | Tests critic **fires** (profile has a test command): runs the test command as a subprocess inside the workdir with a 5-minute timeout + 2 MB output cap, turns non-zero/timeout into a HIGH finding with truncated stdout/stderr evidence. Writes `reviews/<iter>/tests.md`. Runs alongside the LLM critics via `Promise.allSettled`. |
| `deliver` | Locates the `worktree_created` event to recover `branch` + `baseBranch`. Runs `git diff <base>..HEAD` for a diff summary. The delivery markdown grows a **Changes** section with branch, worktree path, `git diff`/`git merge`/`git worktree remove` commands. Journal stanza includes the branch. |
| `decisions` | Unchanged — runs in the worktree cwd, commits on the run branch show up in its prompt. |

---

## 4. Edit-mode change with a GitHub PR

```sh
npm run mill -- new "expose /healthz on the admin server" --mode edit --pr
```

`--pr` is a flag on intake that gets recorded in the `worktree_created`
payload and consumed by `deliver`.

Most of the pipeline is identical to example 3. The `deliver` stage is what
differs:

- **Before PR attempt**, `deliver` checks `passed = verifyPass && no
  HIGH/CRITICAL findings`. A failed run does **not** open a PR (the user
  shouldn't pay for a broken one).
- If `passed && worktree.pr`:
  1. `execFile("gh", ["--version"])` — if `gh` isn't on PATH, record
     `pr_skipped` event and give up.
  2. `execFile("git", ["remote", "get-url", "origin"])` in the workdir. No
     remote → `pr_skipped`.
  3. `git push -u origin <branch>` from the worktree. Push failure →
     `pr_push_failed` event; no PR.
  4. `gh pr create --title "mill: run <id>" --body-file <delivery.md>
     --base <baseBranch> --head <branch>`. Success → `pr_opened` event with
     URL; delivery markdown's **Changes** section gains a **Pull request**
     line.
- None of these failure modes flip the run to `failed` — the run has already
  shipped locally; the PR is a best-effort wrapper around that.

The `decisions` stage still runs post-deliver with the same best-effort
semantics.

---

## 5. Plan-and-review: `--stop-after design`

```sh
npm run mill -- new "oauth2 device code flow for CLI login" --stop-after design
```

Useful when you want to pay for spec+design, review them by hand, and then
decide whether to proceed. The resume path is the same one used for crash
recovery, so this is a cheap feature built on top of stage-idempotent
recovery.

Timeline:

1. **Intake → clarify → answers** run inline in the CLI as usual.
2. **Spec** runs. Harness calls `plannedStop("spec")` — does nothing because
   `--stop-after` is `design`.
3. **Design** runs. Harness calls `plannedStop("design")` — returns a
   `PipelineResult` with `status: "planned"` and a `reason` telling the user
   how to resume. The CLI prints the spec + architecture paths and the
   `mill run <id>` invocation to continue.
4. The run row is left as `running` (not `failed`, not `completed`). Stage
   rows for `intake`, `clarify`, `spec`, `design` are all `completed`.

When the user runs:

```sh
npm run mill -- run <run-id>
```

The harness calls `runPipeline` without `stopAfter`. `needsStage(ctx, "spec")`
and `needsStage(ctx, "design")` both return false because their stage rows
are `completed`. So the pipeline jumps straight into `spec2tests` (or the
implement⇄review loop if that's skipped) and proceeds to delivery.

`--stop-after` accepts `spec`, `design`, `spec2tests`. It has nothing to do
with Claude Code's in-process `permissionMode: plan` — that's a `claude`
feature for sketching without tool calls; this is a harness feature for
gating the pipeline at a stage boundary.

---

## 6. Kill a runaway run, resume a crashed one

These share machinery (the `KILLED` sentinel + stage-idempotent recovery), so
they're described together.

### Kill

```sh
npm run mill -- kill <run-id>
```

1. CLI writes `runs/<id>/KILLED` with a timestamp.
2. CLI calls `store.updateRun(runId, { status: "killed" })`.
3. Two things observe the sentinel:
   - **Guard (in-flight):** the `PreToolUse` hook in every `claude` subprocess
     reads `MILL_RUN_KILLED` (absolute sentinel path) and short-circuits
     every tool call with a denial. This stops whatever `claude` is doing
     *right now*.
   - **Pipeline (between stages):** after each stage returns, `throwIfKilled
     OrBroken` calls `killedSentinelExists(ctx.paths.killed)` and throws
     `KilledError`. The outer try/catch updates `run.status = killed`,
     records a `pipeline killed` log line, and returns cleanly.
4. The CLI process that was running the pipeline inline also has a SIGINT /
   SIGTERM handler (`installInlineAbortHandler`). First signal calls
   `ctx.abortController.abort()`, which propagates SIGTERM→SIGKILL to the
   active `claude` child via `runClaude.onAbort`. Second signal forces
   `process.exit(130)`.

To retry a killed run you have to delete the sentinel yourself: the CLI
prints that instruction.

### Resume after a crash

Same plumbing, opposite intent:

```sh
npm run mill -- run <run-id>
```

1. Harness loads config, opens the store, reads the run row. Refuses
   `completed` ("nothing to do") and `killed` (must delete sentinel).
2. `buildContext` re-materializes the `RunContext` with same paths, budget,
   logger. Budget tracker is reseeded from the `runs.total_cost_usd` column
   so the per-run cap enforces across restarts.
3. `runPipeline` walks the stage list. For each stage, `needsStage` checks
   `store.getStage(...).status`: `completed` and `skipped` short-circuit;
   anything else (`failed`, `running`, missing) reruns.
4. **Session continuity.** Stages that saved session ids do the same
   `--resume <id>` dance they always do. The implementer keeps its context
   across resume and across review iterations; each critic keeps its own.
5. **Transactional finalization.** Crash recovery is only safe because
   `addRunCost` + `addRunUsage` + `saveSession` + `finishStage` are wrapped
   in `store.transaction(...)`. A crash between those calls would double-bill
   on resume; the transaction guarantees they commit together. `claude-cli.ts`
   deliberately does **not** touch the DB — the caller's transaction owns
   that.
6. **Post-deliver quirk.** `decisions` catches its own errors and always
   returns `ok: true`. Its stage row still gets written so resume doesn't
   re-enter it forever. Future post-deliver stages must follow the same
   pattern.

---

## 7. Detached run via the worker

```sh
npm run mill -- new "generate an OpenAPI spec for src/http/*" --detach
# in another terminal:
npm run worker
```

`--detach` is the "I don't want to babysit the inline pipeline" affordance.
Intake + clarify + answer prompt still run inline in the CLI, but after
`recordAnswers` the CLI returns without calling `runPipeline`. The run row is
`status = running` (flipped by `recordAnswers`).

The worker:

1. Polls SQLite for runs in `running`/`queued` states.
2. For each, builds a fresh `RunContext` and calls `runPipeline` exactly like
   the inline path. All the same recovery / kill / transactional rules apply.
3. Respects `MILL_MAX_CONCURRENT_RUNS` (default 2).

Useful alongside `--stop-after`: hand-review spec+design inline, then
`mill run <id>` can itself be detached by letting the worker pick it up if
the run is `running`.

The CLI's `tail`/`logs` / `status` subcommands read SQLite directly and
don't care whether the run is inline-driven or worker-driven.

---

## 8. One-shot: `mill onboard`

```sh
npm run mill -- onboard            # no-op if .mill/profile.md already exists
npm run mill -- onboard --refresh  # force rebuild
```

Only stage-like thing in mill that's **not** a pipeline stage. The harness:

1. `preflightClaude()` — bail if the `claude` CLI is missing.
2. Short-circuits on an existing profile unless `--refresh`.
3. Loads `prompts/onboard.md`, calls `runClaudeOneShot` (sibling of
   `runClaude` that skips the per-run sandbox because there *is* no run).
   Tools are `Read/Glob/Grep/Bash`; `Edit/Write` etc. are explicitly denied.
   Budget capped at $2 and 10 minutes wall clock. JSON schema forces
   `{stack, commands: {test, build, lint, typecheck, devServer, format},
   doNotTouch[], markdown}`.
4. Writes `.mill/profile.json` + `.mill/profile.md`. The markdown is what's
   injected into future spec/design/implement prompts via
   `readProfileSummary`. The JSON is what the tests critic + spec2tests
   read for the test command.

No run row, no stage rows, no sandbox hook. It's a one-shot so a fresh repo
can be profiled once and every subsequent `mill new` gets richer prompts.

---

## 9. Adversarial review via the Codex plugin

```sh
# Prereq (once): /plugin install codex@openai-codex  +  codex login
MILL_ADVERSARIAL_REVIEW=auto npm run mill -- new "..." --mode edit
```

This is an **extra critic** during `review`, not a new stage. The harness
behavior is gated by `MILL_ADVERSARIAL_REVIEW` (`auto`|`on`|`off`) and by
availability of both the Codex plugin and the `codex` CLI.

Per review iteration:

1. `review.ts` calls `canRunAdversarial()`, which walks
   `~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs`
   and returns the companion path (version-sorted). Also respects a
   `MILL_CODEX_COMPANION` override.
2. If the plugin is present, `isCodexCliAvailable()` probes `codex
   --version` with a 5 s timeout (cached per-process).
3. If either check fails and `MILL_ADVERSARIAL_REVIEW=on`, the stage throws.
   In `auto`, it silently skips. In `off`, it never runs.
4. If enabled, the adversarial critic is pushed into the `Promise.allSettled`
   pool alongside security/correctness/ux/tests.
5. The critic spawns `node <companion-path> adversarial-review --wait --json
   --base impl/iter-0 <focus>` with `CLAUDE_PLUGIN_ROOT` pointing at the
   plugin dir. `impl/iter-0` is the stable base tag placed at intake (edit
   mode) or at the first `implement` iteration (new mode). Timeout is
   `max(stageTimeoutMs, 10 min)`.
6. On success it parses the JSON payload, converts findings to the standard
   `Finding` shape, persists them via `store.insertFinding` (per-iteration),
   and writes `reviews/<iter>/adversarial.md`.
7. On failure it returns zero findings + a summary explaining what went
   wrong. Cost + token usage are zero — Codex billing is out of band.

The feedback loop into `implement` is unchanged: any HIGH/CRITICAL
adversarial finding feeds forward like any other critic's finding.

---

## Cross-cutting notes

A few things the harness does that aren't visible in any single stage but
matter for every workflow above:

- **Cross-run memory auto-injection.** `spec`, `design`, `spec2tests`, and
  `implement` all prepend tails of `.mill/journal.md` + `.mill/decisions.md`
  and (in edit mode) the findings ledger + profile summary. Every stage that
  starts from a spec should match this pattern.
- **CLAUDE.md auto-discovery.** The harness deliberately does **not** read or
  inject `CLAUDE.md`. Claude Code picks it up from cwd upward, and the stage
  prompts tell the model "CLAUDE.md is ground truth; any mill block that
  disagrees loses."
- **Permissions layering.** `permissions.deny` in per-run `settings.json`
  holds the static destructive-command list; `guard.ts` holds the dynamic
  checks (`KILLED` sentinel, write-dir allow-list). New static bans belong
  in `run-settings.ts`, not in the guard.
- **Session slots.** Slot names are the stage name for single-session stages
  (`implement`, `verify`, `decisions`) and `<stage>:<sub>` for critics
  (`review:security`, `review:correctness`, `review:ux`). Slot conventions
  drive both resume behavior and `store.saveSession` bookkeeping.
- **Structured output discipline.** Stages that need JSON always use
  `pickStructured(res)`, never `JSON.parse(res.text)`. `pickStructured`
  raises on `error_max_turns` / `error_during_execution` / `error_budget`
  rather than masking them as parse failures.
