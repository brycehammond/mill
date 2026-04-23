// Generates the per-run `.claude/settings.json` that Claude Code picks up
// when its cwd is under runs/<id>/. Settings inject a PreToolUse hook
// pointing at `guard.ts` (or the compiled guard.js), plus a small deny list
// of destructive shell patterns.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunPaths } from "../core/index.js";

const thisFile = fileURLToPath(import.meta.url);
const thisDir = dirname(thisFile);
const isSourceMode = thisFile.endsWith(".ts");

// Locate the tsx binary by walking up from this file to find node_modules/.bin/tsx.
function findTsxBin(): string | null {
  let dir = thisDir;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Produce the shell command that Claude Code should run for each PreToolUse.
// In dev (running from src/), we need tsx to execute the .ts guard. In prod
// (running from dist/), plain `node` is enough.
export function guardCommand(): string {
  if (isSourceMode) {
    const tsx = findTsxBin();
    const guardTs = resolve(thisDir, "guard.ts");
    if (!tsx) {
      // Fallback: prefer failing loudly over silently letting the agent run
      // without sandbox. `node --import tsx/esm` would be another path but
      // it requires tsx >= 4.7 and still needs the loader on PATH.
      throw new Error(
        "df: could not locate node_modules/.bin/tsx; run `npm install` in the dark-factory checkout",
      );
    }
    return `${quote(tsx)} ${quote(guardTs)}`;
  }
  const guardJs = resolve(thisDir, "guard.js");
  return `${quote(process.execPath)} ${quote(guardJs)}`;
}

function quote(s: string): string {
  // Simple shell-quote: wrap in single quotes, escape embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RunSettingsOptions {
  paths: RunPaths;
}

// Writes runs/<id>/workdir/.claude/settings.json. Empirically, Claude Code's
// `--setting-sources project` reads `.claude/settings.json` from the cwd
// only — it does NOT walk up (verified 2026-04-22 against claude 2.1.117).
// The workdir's git repo ignores `.claude/` via `.git/info/exclude` (written
// by implement.ts at git-init time) so the delivered artifact stays clean.
export function writeRunSettings(opts: RunSettingsOptions): string {
  const settingsDir = join(opts.paths.workdir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json");

  const command = guardCommand();

  const body = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command }],
        },
      ],
    },
    permissions: {
      deny: [
        "Bash(sudo:*)",
        "Bash(rm -rf /:*)",
        "Bash(rm -rf /*:*)",
        "Bash(:(){:|:&};:)",
      ],
    },
  };

  writeFileSync(settingsPath, JSON.stringify(body, null, 2) + "\n", "utf8");
  return settingsPath;
}
