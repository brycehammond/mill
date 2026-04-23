// Subprocess runner for the `claude` CLI. Replaces the Claude Agent SDK —
// the SDK is itself a wrapper around this same binary, and we can cut out
// the middleman. Flag surface mirrors what the SDK passes internally (see
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs during development).

import { spawn } from "node:child_process";
import type { PermissionMode, RunContext, StageName } from "../core/index.js";
import { KilledError, killedSentinelExists } from "../core/index.js";

export interface McpServerConfig {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface RunClaudeArgs {
  ctx: RunContext;
  stage: StageName;
  prompt: string;
  appendSystemPrompt?: string;
  systemPrompt?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  settingSources?: Array<"user" | "project" | "local">;
  addDir?: string[];
  // Paths outside the workdir where the stage is allowed to Write/Edit.
  // Passed through to the guard.ts sandbox via DF_EXTRA_WRITE_DIRS.
  extraWriteDirs?: string[];
  maxTurns?: number;
  maxThinkingTokens?: number;
  maxBudgetUsd?: number;
  jsonSchema?: unknown;
  resume?: string;
  forkSession?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunClaudeResult {
  text: string;
  // When `jsonSchema` is passed, Claude Code delivers the schema-conforming
  // payload here (already parsed). `text` in that mode is just the model's
  // natural-language summary. Null when `jsonSchema` was not used.
  structuredOutput: unknown;
  sessionId: string;
  costUsd: number;
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_budget";
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
    prompt,
    appendSystemPrompt,
    systemPrompt,
    cwd,
    permissionMode,
    allowedTools,
    disallowedTools,
    mcpServers,
    settingSources,
    addDir = [],
    extraWriteDirs = [],
    maxTurns,
    maxThinkingTokens,
    maxBudgetUsd,
    jsonSchema,
    resume,
    forkSession,
    env: extraEnv,
    timeoutMs,
  } = args;

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
  // Per-stage budget cap. Default to the per-stage limit if the caller
  // didn't override — every stage should have a hard cap, no exceptions.
  const effectiveBudget =
    maxBudgetUsd != null ? maxBudgetUsd : ctx.budget.limits.stageBudgetUsd;
  if (effectiveBudget > 0) argv.push("--max-budget-usd", String(effectiveBudget));
  if (permissionMode) argv.push("--permission-mode", permissionMode);
  if (allowedTools && allowedTools.length > 0) argv.push("--allowedTools", allowedTools.join(","));
  if (disallowedTools && disallowedTools.length > 0) argv.push("--disallowedTools", disallowedTools.join(","));
  if (mcpServers && Object.keys(mcpServers).length > 0) argv.push("--mcp-config", JSON.stringify({ mcpServers }));
  if (settingSources && settingSources.length > 0) argv.push("--setting-sources", settingSources.join(","));
  if (jsonSchema) argv.push("--json-schema", JSON.stringify(jsonSchema));
  if (appendSystemPrompt) argv.push("--append-system-prompt", appendSystemPrompt);
  else if (systemPrompt) argv.push("--append-system-prompt", systemPrompt);
  for (const dir of addDir) argv.push("--add-dir", dir);

  const env = {
    ...process.env,
    ...extraEnv,
    CLAUDE_CODE_ENTRYPOINT: "df-harness",
    DF_RUN_ID: ctx.runId,
    DF_RUN_KILLED: ctx.paths.killed,
    DF_WORKDIR: ctx.paths.workdir,
    ...(extraWriteDirs.length > 0
      ? { DF_EXTRA_WRITE_DIRS: extraWriteDirs.join(":") }
      : {}),
  };

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

  // Default to the context's stage timeout if the caller didn't override.
  // Hung stages are a real failure mode — `claude` can wedge on MCP calls
  // or infinite tool-use loops.
  const effectiveTimeoutMs =
    timeoutMs && timeoutMs > 0 ? timeoutMs : ctx.stageTimeoutMs;
  const timer =
    effectiveTimeoutMs > 0 ? setTimeout(onAbort, effectiveTimeoutMs) : undefined;
  if (timer) timer.unref();

  let stdoutBuf = "";
  // Wrap in an object so TS doesn't narrow the initializer type through the
  // closure-captured mutation in handleLine (control-flow analysis can't see
  // past async callbacks).
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
    try {
      ctx.store.appendEvent(ctx.runId, stage, msgType, msg);
    } catch (err) {
      ctx.logger.warn("failed to append event", { err: String(err), msgType });
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
      };
      resultBox.value = {
        text: typeof rm.result === "string" ? rm.result : "",
        structuredOutput: rm.structured_output ?? null,
        sessionId: rm.session_id ?? "",
        costUsd: rm.total_cost_usd ?? 0,
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
    if (text) ctx.logger.debug("claude stderr", { text });
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
  });

  ctx.abortController.signal.removeEventListener("abort", onAbort);
  if (timer) clearTimeout(timer);

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

  // In-memory budget tally only — DB writes (addRunCost, saveSession) are the
  // caller's job so they can happen in the same transaction as finishStage.
  // Budget check fires here so an over-budget stage doesn't falsely succeed.
  ctx.budget.addCost(stage, result.costUsd);
  ctx.budget.checkRunBudget();

  return result;
}

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
