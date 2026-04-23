import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { RunContext, StageResult } from "../../core/index.js";
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

  // Stitch MCP is expected to be configured in the user's global Claude
  // settings — settingSources: ['user'] pulls it in automatically.
  const res = await runClaude({
    ctx,
    stage: "design",
    prompt: `Spec:\n\n${specBody}`,
    systemPrompt,
    // Inherit the user's global Claude Code config so the Stitch MCP
    // (defined in ~/.claude/settings.json) is available. `project` picks
    // up our per-run sandbox settings at runs/<id>/.claude/settings.json.
    settingSources: ["user", "project"],
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
