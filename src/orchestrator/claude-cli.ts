// Subprocess runner for the `claude` CLI. Replaces the Claude Agent SDK —
// the SDK is itself a wrapper around this same binary, and we can cut out
// the middleman. Flag surface mirrors what the SDK passes internally (see
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs during development).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PermissionMode,
  RunContext,
  StageName,
  TokenUsage,
} from "../core/index.js";
import { KilledError, killedSentinelExists, ZERO_USAGE } from "../core/index.js";
import { checkInflight as checkBudgetInflight } from "../daemon/budget.js";

// Resolve paths to JSON files containing user-level MCP servers.
// `--mcp-config <path>` loads only the `mcpServers` key from the file —
// hooks in the same file are ignored. That's how we get access to user
// MCPs (Stitch, Playwright, etc.) without triggering user-level hooks.
//
// Claude Code stores MCPs in two different files in practice:
//   - `~/.claude/settings.json` (managed via `claude mcp add`)
//   - `~/.claude.json`          (older location, still written by some flows)
// Users commonly have servers split across both, so we return every file
// that exists and let the caller pass each to `--mcp-config` (the flag is
// repeatable). Override with MILL_USER_MCP_CONFIG to force a single file.
function resolveUserMcpConfigPaths(): string[] {
  const override = process.env.MILL_USER_MCP_CONFIG?.trim();
  if (override) return existsSync(override) ? [override] : [];
  const candidates = [
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".claude.json"),
  ];
  return candidates.filter((p) => existsSync(p));
}

export interface McpServerConfig {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface AgentDef {
  description: string;
  prompt: string;
  // Whitelist of tool names the subagent may use. Array form only — the CLI
  // silently rejects the agent definition if this is a comma-string.
  tools?: string[];
  model?: string;
}

export interface RunClaudeArgs {
  ctx: RunContext;
  stage: StageName;
  // Session slot for saveSession / resume bookkeeping. Defaults to `stage`.
  // Callers that run multiple `claude` subprocesses under the same stage
  // (critics, team-lead) pass unique slots like "review:security" so each
  // subprocess can resume its own session across iterations.
  sessionSlot?: string;
  prompt: string;
  systemPrompt?: string;
  // Inline custom subagent definitions injected via --agents <json>. Each
  // key is the subagent_type name. Used by team-mode stages to register
  // critic personas without touching user/project agent directories.
  agentsConfig?: Record<string, AgentDef>;
  // How `systemPrompt` is delivered. "append" (default) adds to Claude
  // Code's default system prompt — safest for stages that rely on the
  // default tool-use guidance (implement, verify). "replace" uses the
  // stage prompt verbatim — correct for critics and other narrowly
  // scoped stages where the default coder framing would leak in.
  systemPromptMode?: "append" | "replace";
  cwd?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  // When true, also load MCP servers from the user's global Claude Code
  // config (~/.claude/settings.json) via --mcp-config. This is the
  // MCPs-without-hooks path — unlike settingSources: ["user"], it does
  // NOT pull in user-level hooks (Stop, PostToolUse, etc.). Use this
  // for stages that need MCPs like Stitch or Playwright but shouldn't
  // trigger the user's Slack/webhook integrations.
  inheritUserMcps?: boolean;
  settingSources?: Array<"user" | "project" | "local">;
  addDir?: string[];
  // Paths outside the workdir where the stage is allowed to Write/Edit.
  // Passed through to the guard.ts sandbox via MILL_EXTRA_WRITE_DIRS.
  extraWriteDirs?: string[];
  maxTurns?: number;
  maxThinkingTokens?: number;
  jsonSchema?: unknown;
  resume?: string;
  forkSession?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
  // Iteration index for stages that loop (implement, review). When set,
  // every cumulative cost/usage/session write to `stages` is mirrored to
  // the per-iteration row in `stage_iterations` so display surfaces can
  // expand the loop into iteration#N rows. Sum of per-iteration cost
  // equals the cumulative `stages.cost_usd` by construction. Leave
  // unset for non-iterating stages — they get one row in `stages` and
  // no `stage_iterations` rows.
  iteration?: number;
}

export interface RunClaudeResult {
  text: string;
  // When `jsonSchema` is passed, Claude Code delivers the schema-conforming
  // payload here (already parsed). `text` in that mode is just the model's
  // natural-language summary. Null when `jsonSchema` was not used.
  structuredOutput: unknown;
  sessionId: string;
  costUsd: number;
  // Token counts from the `result` message's `usage` object. Zeroed when
  // absent (older claude versions or the `error_*` subtypes).
  usage: TokenUsage;
  subtype: "success" | "error_max_turns" | "error_during_execution";
  durationMs: number;
  numTurns: number;
  isError: boolean;
}

export class ClaudeNotFoundError extends Error {
  constructor() {
    super(
      "Claude Code CLI not found on PATH. Install: `npm i -g @anthropic-ai/claude-code`",
    );
  }
}

export async function runClaude(args: RunClaudeArgs): Promise<RunClaudeResult> {
  const {
    ctx,
    stage,
    sessionSlot,
    prompt,
    systemPrompt,
    systemPromptMode = "append",
    agentsConfig,
    cwd,
    permissionMode,
    allowedTools,
    disallowedTools,
    mcpServers,
    inheritUserMcps,
    settingSources,
    addDir = [],
    extraWriteDirs = [],
    maxTurns,
    maxThinkingTokens,
    jsonSchema,
    resume,
    forkSession,
    env: extraEnv,
    timeoutMs,
    iteration,
  } = args;
  const slot = sessionSlot ?? stage;

  if (killedSentinelExists(ctx.paths.killed)) {
    throw new KilledError(ctx.runId);
  }

  const argv: string[] = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
  ];

  if (ctx.model) argv.push("--model", ctx.model);
  if (resume) argv.push("--resume", resume);
  if (forkSession) argv.push("--fork-session");
  if (maxTurns) argv.push("--max-turns", String(maxTurns));
  if (maxThinkingTokens) argv.push("--max-thinking-tokens", String(maxThinkingTokens));
  if (permissionMode) argv.push("--permission-mode", permissionMode);
  if (allowedTools && allowedTools.length > 0) argv.push("--allowedTools", allowedTools.join(","));
  if (disallowedTools && disallowedTools.length > 0) argv.push("--disallowedTools", disallowedTools.join(","));
  // MCP wiring. Two sources can contribute:
  //   - inline `mcpServers` arg (stage-specific injection)
  //   - `inheritUserMcps` flag, which loads `~/.claude/settings.json` as
  //     a second --mcp-config. Only the `mcpServers` field is consumed;
  //     hooks in that file do NOT fire. That's the point — this is the
  //     "MCPs without user hooks" path.
  // If either is present, `--strict-mcp-config` makes claude ignore every
  // other MCP source so we can't accidentally pull in user hooks via
  // settings MCPs or similar.
  const mcpConfigs: string[] = [];
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    mcpConfigs.push(JSON.stringify({ mcpServers }));
  }
  if (inheritUserMcps) {
    for (const userMcpPath of resolveUserMcpConfigPaths()) {
      mcpConfigs.push(userMcpPath);
    }
  }
  if (mcpConfigs.length > 0) {
    argv.push("--mcp-config", ...mcpConfigs);
    argv.push("--strict-mcp-config");
  }
  if (settingSources && settingSources.length > 0) argv.push("--setting-sources", settingSources.join(","));
  if (jsonSchema) argv.push("--json-schema", JSON.stringify(jsonSchema));
  // "append" (default) tacks onto Claude Code's default prompt, keeping
  // its tool-use guidance. "replace" supplies the only system prompt
  // the model sees — right for narrow roles like critics.
  if (systemPrompt) {
    const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    argv.push(flag, systemPrompt);
  }
  if (agentsConfig && Object.keys(agentsConfig).length > 0) {
    argv.push("--agents", JSON.stringify(agentsConfig));
  }
  for (const dir of addDir) argv.push("--add-dir", dir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    MILL_RUN_ID: ctx.runId,
    MILL_RUN_KILLED: ctx.paths.killed,
    MILL_WORKDIR: ctx.paths.workdir,
    ...(extraWriteDirs.length > 0
      ? { MILL_EXTRA_WRITE_DIRS: extraWriteDirs.join(":") }
      : {}),
  };
  // Force `claude` onto its own login flow (subscription / workspace).
  // If ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN leaks through from the
  // parent env, claude silently switches to API billing — surprising the
  // user with a bill they didn't opt into.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const child = spawn("claude", argv, {
    cwd: cwd ?? ctx.paths.workdir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let spawnError: Error | null = null;
  child.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    spawnError = code === "ENOENT" ? new ClaudeNotFoundError() : (err as Error);
  });

  const userMessage = JSON.stringify({
    type: "user",
    message: { role: "user", content: prompt },
  });
  child.stdin.write(userMessage + "\n");
  child.stdin.end();

  const onAbort = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000).unref();
    }
  };
  ctx.abortController.signal.addEventListener("abort", onAbort);

  // Default to the stage-specific override, then the context default, if the
  // caller didn't override. Hung stages are a real failure mode — `claude`
  // can wedge on MCP calls or infinite tool-use loops.
  const effectiveTimeoutMs =
    timeoutMs && timeoutMs > 0
      ? timeoutMs
      : (ctx.stageTimeoutsMs[stage] ?? ctx.stageTimeoutMs);
  const timer =
    effectiveTimeoutMs > 0 ? setTimeout(onAbort, effectiveTimeoutMs) : undefined;
  if (timer) timer.unref();

  let stdoutBuf = "";
  // Wrap in an object so TS doesn't narrow the initializer type through the
  // closure-captured mutation in handleLine (control-flow analysis can't see
  // past async callbacks).
  const resultBox: { value: RunClaudeResult | null } = { value: null };

  // Post-final-result grace timer. Armed only when claude emits a result
  // that carries `structured_output` (i.e., the schema-validated payload
  // this call was waiting for). In team mode the lead sometimes lingers
  // for minutes after that — processing idle/shutdown messages from
  // torn-down teammates — and the OS process can even outlive
  // `child.on("close")`, leaving a zombie. Once we see the final payload
  // we have everything we need; after this grace we force-kill.
  // Intermediate results (team-mode per-turn, non-schema stages) don't
  // arm the timer, so long-thinking turns are not at risk of being cut off.
  const POST_RESULT_GRACE_MS = 20_000;
  let postResultTimer: NodeJS.Timeout | null = null;

  // Incremental persistence. Each `result` event carries `total_cost_usd`
  // that is cumulative for the session; we persist the delta so a SIGTERM
  // mid-stream still leaves accurate cost/usage on the stage and run rows.
  // session_id is picked up from `system/init` and saved immediately so a
  // killed stage can resume via `--resume <sid>` instead of starting over.
  let persistedCostUsd = 0;
  let persistedUsage: TokenUsage = { ...ZERO_USAGE };
  let persistedSessionId = "";

  const persistSession = (sid: string) => {
    if (!sid || sid === persistedSessionId) return;
    persistedSessionId = sid;
    try {
      // Only the primary session for a stage goes on the stage row's
      // session_id column. Sub-slots (critic-specific sessions under
      // stage="review") persist only to the sessions table so the
      // stage row's id keeps its meaning.
      if (slot === stage) {
        ctx.store.setStageSession(ctx.runId, stage, sid);
        if (iteration !== undefined) {
          ctx.store.setStageIterationSession(ctx.runId, stage, iteration, sid);
        }
      }
      ctx.store.saveSession(ctx.runId, slot, sid, persistedCostUsd);
    } catch (err) {
      ctx.logger.warn("failed to persist session id", { err: String(err) });
    }
  };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const msgType = typeof msg.type === "string" ? msg.type : "unknown";
    try {
      ctx.store.appendEvent(ctx.runId, stage, msgType, msg);
    } catch (err) {
      ctx.logger.warn("failed to append event", { err: String(err), msgType });
    }
    // Session id is available at `system/init` — the earliest possible point.
    // Persist then so a crash before any `result` message still leaves a
    // session id the user can resume against.
    if (msgType === "system") {
      const sid = typeof msg.session_id === "string" ? msg.session_id : "";
      if (sid) persistSession(sid);
    }
    if (msgType === "result") {
      const rm = msg as {
        type: "result";
        subtype: RunClaudeResult["subtype"];
        duration_ms?: number;
        num_turns?: number;
        is_error?: boolean;
        session_id?: string;
        total_cost_usd?: number;
        result?: string;
        structured_output?: unknown;
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
      };
      const u = rm.usage ?? {};
      const turnUsage: TokenUsage = {
        input: safeInt(u.input_tokens),
        cache_creation: safeInt(u.cache_creation_input_tokens),
        cache_read: safeInt(u.cache_read_input_tokens),
        output: safeInt(u.output_tokens),
      };
      resultBox.value = {
        text: typeof rm.result === "string" ? rm.result : "",
        structuredOutput: rm.structured_output ?? null,
        sessionId: rm.session_id ?? persistedSessionId,
        costUsd: rm.total_cost_usd ?? 0,
        usage: turnUsage,
        subtype: rm.subtype,
        durationMs: rm.duration_ms ?? 0,
        numTurns: rm.num_turns ?? 0,
        isError: Boolean(rm.is_error),
      };
      // Persist the delta since the last result. total_cost_usd is
      // cumulative across the session; turn usage is per-turn, so we
      // accumulate it directly. The in-memory tracker mirrors the DB
      // adds for live reporting (delivery summary, pipeline result).
      const costDelta = Math.max(0, (rm.total_cost_usd ?? 0) - persistedCostUsd);
      if (costDelta > 0) {
        try {
          ctx.store.addRunCost(ctx.runId, costDelta);
          ctx.store.addStageCost(ctx.runId, stage, costDelta);
          if (iteration !== undefined) {
            ctx.store.addStageIterationCost(ctx.runId, stage, iteration, costDelta);
          }
        } catch (err) {
          ctx.logger.warn("failed to persist cost delta", { err: String(err) });
        }
        ctx.costs.addCost(stage, costDelta);
        persistedCostUsd += costDelta;
        // Phase 3: monthly budget enforcement. Best-effort — a budget
        // read failure cannot lose the cost write that just landed. The
        // pipeline driver does the actual unwind at the next stage
        // boundary by observing runs.status === 'paused_budget'.
        try {
          checkBudgetInflight(ctx.store, ctx.projectId, ctx.runId, stage);
        } catch (err) {
          ctx.logger.warn("budget inflight check failed", {
            err: String(err),
          });
        }
      }
      if (
        turnUsage.input +
          turnUsage.cache_creation +
          turnUsage.cache_read +
          turnUsage.output >
        0
      ) {
        try {
          ctx.store.addRunUsage(ctx.runId, turnUsage);
          ctx.store.addStageUsage(ctx.runId, stage, turnUsage);
          if (iteration !== undefined) {
            ctx.store.addStageIterationUsage(ctx.runId, stage, iteration, turnUsage);
          }
        } catch (err) {
          ctx.logger.warn("failed to persist usage delta", { err: String(err) });
        }
        ctx.costs.addUsage(stage, turnUsage);
        persistedUsage = {
          input: persistedUsage.input + turnUsage.input,
          cache_creation: persistedUsage.cache_creation + turnUsage.cache_creation,
          cache_read: persistedUsage.cache_read + turnUsage.cache_read,
          output: persistedUsage.output + turnUsage.output,
        };
      }
      const sid = rm.session_id ?? persistedSessionId;
      if (sid) {
        persistSession(sid);
        // Update the sessions table's cost-at-last-update snapshot.
        try {
          ctx.store.saveSession(ctx.runId, slot, sid, persistedCostUsd);
        } catch (err) {
          ctx.logger.warn("failed to update session cost", { err: String(err) });
        }
      }
      // Arm the force-kill only once we have the final structured payload
      // a schema-using caller was waiting on. Intermediate per-turn results
      // (team mode) or non-schema results don't trip this.
      const isFinalSchemaResult =
        Boolean(jsonSchema) &&
        rm.structured_output !== undefined &&
        rm.structured_output !== null;
      if (isFinalSchemaResult && postResultTimer === null) {
        postResultTimer = setTimeout(() => {
          if (!child.killed) {
            ctx.logger.debug(
              "claude lingered past post-result grace; forcing exit",
              { stage, runId: ctx.runId, graceMs: POST_RESULT_GRACE_MS },
            );
            onAbort();
          }
        }, POST_RESULT_GRACE_MS);
        postResultTimer.unref();
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) ctx.logger.debug("claude stderr", { text });
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
  });

  ctx.abortController.signal.removeEventListener("abort", onAbort);
  if (timer) clearTimeout(timer);
  if (postResultTimer) clearTimeout(postResultTimer);

  if (stdoutBuf.trim()) handleLine(stdoutBuf);

  if (spawnError) throw spawnError;

  if (killedSentinelExists(ctx.paths.killed)) {
    throw new KilledError(ctx.runId);
  }

  const result = resultBox.value;
  if (!result) {
    throw new Error(
      `claude (${stage}) exited ${exitCode} without producing a result message`,
    );
  }

  return result;
}

function safeInt(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

export interface RunClaudeOneShotArgs {
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  settingSources?: Array<"user" | "project" | "local">;
  jsonSchema?: unknown;
  maxTurns?: number;
  timeoutMs?: number;
  model?: string;
  addDir?: string[];
  onStderr?: (text: string) => void;
}

// Project-scoped / utility invocation of `claude` with no RunContext.
// Used for operations that are not per-run (e.g. `mill onboard`). No
// session persistence, no event log, no cost tally — the caller
// handles anything beyond "send prompt, get result".
export async function runClaudeOneShot(
  args: RunClaudeOneShotArgs,
): Promise<RunClaudeResult> {
  const argv: string[] = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
  ];

  if (args.model) argv.push("--model", args.model);
  if (args.maxTurns) argv.push("--max-turns", String(args.maxTurns));
  if (args.permissionMode) argv.push("--permission-mode", args.permissionMode);
  if (args.allowedTools && args.allowedTools.length > 0) {
    argv.push("--allowedTools", args.allowedTools.join(","));
  }
  if (args.disallowedTools && args.disallowedTools.length > 0) {
    argv.push("--disallowedTools", args.disallowedTools.join(","));
  }
  if (args.settingSources && args.settingSources.length > 0) {
    argv.push("--setting-sources", args.settingSources.join(","));
  }
  if (args.jsonSchema) argv.push("--json-schema", JSON.stringify(args.jsonSchema));
  if (args.systemPrompt) argv.push("--append-system-prompt", args.systemPrompt);
  for (const dir of args.addDir ?? []) argv.push("--add-dir", dir);

  const probeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: "mill-harness",
  };
  delete probeEnv.ANTHROPIC_API_KEY;
  delete probeEnv.ANTHROPIC_AUTH_TOKEN;
  const child = spawn("claude", argv, {
    cwd: args.cwd,
    env: probeEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let spawnError: Error | null = null;
  child.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    spawnError = code === "ENOENT" ? new ClaudeNotFoundError() : (err as Error);
  });

  const userMessage = JSON.stringify({
    type: "user",
    message: { role: "user", content: args.prompt },
  });
  child.stdin.write(userMessage + "\n");
  child.stdin.end();

  const onAbort = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000).unref();
    }
  };

  const timer =
    args.timeoutMs && args.timeoutMs > 0 ? setTimeout(onAbort, args.timeoutMs) : undefined;
  if (timer) timer.unref();

  let stdoutBuf = "";
  const resultBox: { value: RunClaudeResult | null } = { value: null };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const msgType = typeof msg.type === "string" ? msg.type : "unknown";
    if (msgType === "result") {
      const rm = msg as {
        type: "result";
        subtype: RunClaudeResult["subtype"];
        duration_ms?: number;
        num_turns?: number;
        is_error?: boolean;
        session_id?: string;
        total_cost_usd?: number;
        result?: string;
        structured_output?: unknown;
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
      };
      const u = rm.usage ?? {};
      resultBox.value = {
        text: typeof rm.result === "string" ? rm.result : "",
        structuredOutput: rm.structured_output ?? null,
        sessionId: rm.session_id ?? "",
        costUsd: rm.total_cost_usd ?? 0,
        usage: {
          input: safeInt(u.input_tokens),
          cache_creation: safeInt(u.cache_creation_input_tokens),
          cache_read: safeInt(u.cache_read_input_tokens),
          output: safeInt(u.output_tokens),
        },
        subtype: rm.subtype,
        durationMs: rm.duration_ms ?? 0,
        numTurns: rm.num_turns ?? 0,
        isError: Boolean(rm.is_error),
      };
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text && args.onStderr) args.onStderr(text);
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
  });

  if (timer) clearTimeout(timer);

  if (stdoutBuf.trim()) handleLine(stdoutBuf);

  if (spawnError) throw spawnError;

  const result = resultBox.value;
  if (!result) {
    throw new Error(
      `claude exited ${exitCode} without producing a result message`,
    );
  }
  return result;
}

// Fallback for call sites that need an empty usage (error paths, tests).
export { ZERO_USAGE };

// Preferred way to read JSON output from a stage that passed `jsonSchema`.
// Claude Code puts the parsed payload in `structured_output`; older versions
// (or the no-schema path) require fence extraction from `text`.
//
// If claude errored out (e.g. subtype=error_max_turns) there is no payload —
// surface that directly instead of masking it as a JSON parse error.
export function pickStructured(res: RunClaudeResult): unknown {
  if (res.structuredOutput !== null && res.structuredOutput !== undefined) {
    return res.structuredOutput;
  }
  if (res.subtype !== "success" || res.isError) {
    throw new Error(
      `claude returned ${res.subtype} (is_error=${res.isError}) — no structured output`,
    );
  }
  try {
    return JSON.parse(res.text);
  } catch {
    return extractJsonBlock(res.text);
  }
}

export function extractJsonBlock<T = unknown>(text: string): T {
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/m.exec(text);
  const raw = (fence ? fence[1]! : text).trim();
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const preview = raw.slice(0, 500);
    throw new Error(
      `failed to parse JSON from agent output: ${String(err)}\n---\n${preview}`,
    );
  }
}

export function extractMarkdownBlock(text: string): string {
  const fence = /```(?:markdown|md)?\s*\n?([\s\S]*?)```/m.exec(text);
  return (fence ? fence[1]! : text).trim();
}
