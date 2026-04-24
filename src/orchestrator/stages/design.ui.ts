import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { RunContext, StageResult } from "../../core/index.js";
import {
  readDecisionsTail,
  readJournalTail,
  readProfileSummary,
} from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { pickStructured, runClaude } from "../claude-cli.js";

const UiDesignOutput = z.object({
  design_intent_md: z.string().min(20),
  stitch_url: z.string(),
  screens: z.array(
    z.object({
      name: z.string(),
      stitch_screen_id: z.string().optional(),
      notes: z.string().optional(),
    }),
  ),
});
const UiDesignSchema = zodToJsonSchema(UiDesignOutput);

export async function designUi(ctx: RunContext): Promise<StageResult> {
  const systemPrompt = await loadPrompt("design-ui");
  const specBody = await readFile(ctx.paths.spec, "utf8");
  const journal = await readJournalTail(ctx.root, 20);
  const decisionsBlock = await readDecisionsTail(ctx.root, 10);
  const profile = await readProfileSummary(ctx.root);
  const profileBlock = profile ? `## Repo profile\n\n${profile}\n` : "";

  const prompt = [profileBlock, decisionsBlock, journal, `## Spec`, specBody]
    .filter((s) => s !== "")
    .join("\n\n");

  // Stitch MCP is expected to be configured in the user's global Claude
  // settings. We pull it in via `inheritUserMcps` rather than
  // `settingSources: ["user"]` so user-level hooks (Stop, PostToolUse,
  // etc.) do NOT fire during mill stages — MCPs without hooks.
  const res = await runClaude({
    ctx,
    stage: "design",
    prompt,
    systemPrompt,
    settingSources: ["project"],
    inheritUserMcps: true,
    permissionMode: "bypassPermissions",
    jsonSchema: UiDesignSchema,
    allowedTools: [
      "mcp__stitch__generate_screen_from_text",
      "mcp__stitch__edit_screens",
      "mcp__stitch__get_screen",
      "mcp__stitch__list_screens",
      "mcp__stitch__create_project",
      "Read",
      "Write",
    ],
    // Stitch generation is async: the model calls create_project,
    // generate_screen_from_text, then polls list_screens until the
    // screen materializes. Add the 2-3 ToolSearch turns Claude Code
    // uses to resolve deferred MCP schemas, plus retries if generation
    // stalls, and 8 is not enough — the first real UI run hit 9.
    maxTurns: 20,
  });

  const parsed = UiDesignOutput.parse(pickStructured(res));
  await writeFile(
    ctx.paths.designIntent,
    parsed.design_intent_md.trim() + "\n",
    "utf8",
  );
  if (parsed.stitch_url) {
    await writeFile(ctx.paths.stitchUrl, parsed.stitch_url.trim() + "\n", "utf8");
  }

  return {
    ok: true,
    cost: res.costUsd,
    data: {
      designIntentPath: ctx.paths.designIntent,
      stitchUrl: parsed.stitch_url,
      screens: parsed.screens,
      sessionId: res.sessionId,
      usage: res.usage,
    },
  };
}
