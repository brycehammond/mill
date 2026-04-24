// `mill onboard` entrypoint. Runs a one-shot `claude` invocation against
// the project root with Read/Glob/Grep access, produces a structured
// ProfileData, and persists it to `.mill/profile.md` + `.mill/profile.json`.
//
// The result is auto-injected into spec, design, and implement
// prompts on every subsequent run, replacing the per-run rediscovery
// cost (usually the first 5-10 turns of every stage).

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  writeProfile,
  readProfile,
  type ProfileData,
} from "../core/profile.js";
import { loadPrompt } from "./prompts.js";
import { loadConfig } from "./config.js";
import {
  pickStructured,
  runClaudeOneShot,
  type RunClaudeResult,
} from "./claude-cli.js";

const ProfileSchema = z.object({
  stack: z.string().min(2),
  commands: z.object({
    test: z.string().nullable(),
    build: z.string().nullable(),
    lint: z.string().nullable(),
    typecheck: z.string().nullable(),
    devServer: z.string().nullable(),
    format: z.string().nullable(),
  }),
  doNotTouch: z.array(z.string()),
  markdown: z.string().min(20),
});

export interface OnboardArgs {
  refresh?: boolean;
  // Override project root (defaults to loadConfig().root).
  root?: string;
  // Override the backing model; otherwise loadConfig().model is used.
  model?: string;
}

export interface OnboardResult {
  profile: ProfileData;
  cached: boolean;
  costUsd: number;
  durationMs: number;
}

export async function onboard(args: OnboardArgs = {}): Promise<OnboardResult> {
  const config = loadConfig();
  const root = args.root ?? config.root;

  if (!args.refresh) {
    const existing = await readProfile(root);
    if (existing) {
      return { profile: existing, cached: true, costUsd: 0, durationMs: 0 };
    }
  }

  const startedAt = Date.now();
  const systemPrompt = await loadPrompt("onboard");
  const res: RunClaudeResult = await runClaudeOneShot({
    prompt:
      "Inspect this repository and produce its profile. Output must match the JSON schema.",
    systemPrompt,
    cwd: root,
    // Read-only: no Edit/Write allowed. Bash is available for
    // `ls`/`cat` equivalents but the model is told to prefer
    // Read/Glob/Grep in the prompt.
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    disallowedTools: [
      "Edit",
      "Write",
      "NotebookEdit",
      "TodoWrite",
      "WebFetch",
      "WebSearch",
    ],
    permissionMode: "default",
    jsonSchema: zodToJsonSchema(ProfileSchema),
    maxTurns: 30,
    maxBudgetUsd: 2.0,
    timeoutMs: 10 * 60 * 1000,
    model: args.model ?? config.model,
  });

  const parsed = ProfileSchema.parse(pickStructured(res));
  const profile: ProfileData = {
    generatedAt: new Date().toISOString(),
    stack: parsed.stack,
    commands: parsed.commands,
    doNotTouch: parsed.doNotTouch,
    markdown: parsed.markdown,
  };
  await writeProfile(root, profile);

  return {
    profile,
    cached: false,
    costUsd: res.costUsd,
    durationMs: Date.now() - startedAt,
  };
}
