#!/usr/bin/env node
// Standalone PreToolUse hook invoked by the `claude` CLI on every tool call.
// Reads the hook payload from stdin, consults env vars set by claude-cli.ts
// (DF_RUN_KILLED, DF_WORKDIR, DF_RUN_ID), and emits a JSON decision.
//
// Runs many times per run — keep it cheap and dependency-free (no core/ imports).
//
// Hook contract: https://docs.claude.com/en/docs/claude-code/hooks
//   block  → `{"decision":"block","reason":"..."}`
//   allow  → `{}`

import { existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

function trace(msg: string): void {
  const path = process.env.DF_GUARD_TRACE;
  if (!path) return;
  try {
    appendFileSync(path, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

function reply(obj: object): void {
  process.stdout.write(JSON.stringify(obj));
}

function insideDir(child: string, parent: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + "/");
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

async function readStdin(): Promise<string> {
  return new Promise((res, rej) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => res(data));
    process.stdin.on("error", rej);
    if (process.stdin.isTTY) res("");
  });
}

async function main(): Promise<void> {
  const payload = await readStdin();
  trace(`payload=${payload.replace(/\s+/g, " ")}`);
  let input: HookInput = {};
  if (payload.trim()) {
    try {
      input = JSON.parse(payload) as HookInput;
    } catch {
      // Malformed payload — fail open so we don't break Claude Code itself.
      reply({});
      return;
    }
  }

  const runKilled = process.env.DF_RUN_KILLED;
  if (runKilled && existsSync(runKilled)) {
    reply({
      decision: "block",
      reason: `run ${process.env.DF_RUN_ID ?? ""} killed by sentinel`,
    });
    return;
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const workdir = process.env.DF_WORKDIR;
  // DF_EXTRA_WRITE_DIRS: colon-separated allow-list for stages that need to
  // write outside the workdir (verify stage writes into runs/<id>/verify/).
  const extraDirs = (process.env.DF_EXTRA_WRITE_DIRS ?? "")
    .split(":")
    .filter(Boolean);
  const allowedWriteDirs = [workdir, ...extraDirs].filter(
    (d): d is string => Boolean(d),
  );

  const pathLike =
    asString(toolInput.file_path) ??
    asString(toolInput.path) ??
    asString(toolInput.notebook_path);

  if (
    allowedWriteDirs.length > 0 &&
    pathLike &&
    (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit")
  ) {
    if (!allowedWriteDirs.some((d) => insideDir(pathLike, d))) {
      reply({
        decision: "block",
        reason: `path outside allowed dirs: ${pathLike}`,
      });
      return;
    }
  }

  // Bash patterns (sudo, rm -rf /, fork bomb) are enforced via
  // settings.json `permissions.deny` — see run-settings.ts. The guard
  // focuses on state that can't be expressed as a static permission:
  // the KILLED sentinel and the dynamic write-dir allow-list.

  reply({});
}

main().catch((err) => {
  // Never crash — fail open. Our job is to be a permissive sandbox, not a
  // bottleneck. Log to stderr for observability.
  process.stderr.write(`df-guard: ${String(err)}\n`);
  reply({});
});
