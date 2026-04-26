import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { RunContext, StageResult } from "../../core/index.js";
import {
  readDecisionsTail,
  readJournalTail,
  readProfileSummary,
  readStitchRef,
  writeStitchRef,
} from "../../core/index.js";
import { loadPrompt } from "../prompts.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { pickStructured, runClaude } from "../claude-cli.js";
import { defaultSettingSources } from "../config.js";

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
  const specBody = await readFile(ctx.paths.spec, "utf8");
  const journal = await readJournalTail(ctx.root, 20);
  const decisionsBlock = await readDecisionsTail(ctx.root, 10);
  const profile = await readProfileSummary(ctx.root);
  const profileBlock = profile ? `## Repo profile\n\n${profile}\n` : "";

  // Reuse mode: edit-mode runs that find a prior `.mill/stitch.json`
  // get a different prompt (instructs `get_project` + `edit_screens`
  // instead of `create_project`) and the project-level Stitch tools
  // needed to confirm/recover from a stale URL. New mode and edit-mode
  // first runs (no prior ref) take the original create-from-scratch
  // path. Stale-URL recovery is the model's job — see design-ui-edit.md.
  const existingRef = await readStitchRef(ctx.root);
  const reuseMode = ctx.mode === "edit" && existingRef !== null;
  const promptName = reuseMode ? "design-ui-edit" : "design-ui";
  const systemPrompt = await loadPrompt(promptName);

  const reuseBlock = reuseMode
    ? `## Reuse Stitch project\n\nA prior run on this repo created a Stitch project. Reuse it instead of creating a new one.\n\n- **URL**: ${existingRef!.projectUrl}\n- **From run**: ${existingRef!.lastRunId}\n`
    : "";

  const prompt = [profileBlock, reuseBlock, decisionsBlock, journal, `## Spec`, specBody]
    .filter((s) => s !== "")
    .join("\n\n");

  // Stitch MCP is expected to be configured in the user's global Claude
  // settings. It comes in via the default `settingSources: ["user", "project"]`
  // (which also enables the user's installed skills/hooks). Set
  // MILL_USER_HOOKS=off if you need hook-isolation here.
  const allowedTools = [
    "mcp__stitch__generate_screen_from_text",
    "mcp__stitch__edit_screens",
    "mcp__stitch__get_screen",
    "mcp__stitch__list_screens",
    "mcp__stitch__create_project",
    "Read",
    "Write",
  ];
  if (reuseMode) {
    // get_project lets the model confirm the persisted URL is still
    // valid; list_projects is the recovery path if it isn't (find a
    // similarly-named project before falling back to create_project).
    allowedTools.push("mcp__stitch__get_project", "mcp__stitch__list_projects");
  }

  const res = await runClaude({
    ctx,
    stage: "design",
    prompt,
    systemPrompt,
    settingSources: defaultSettingSources(),
    permissionMode: "bypassPermissions",
    jsonSchema: UiDesignSchema,
    allowedTools,
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
    // Update the cross-run pointer first, before the per-run artifact.
    // A failure to update `.mill/stitch.json` (e.g. permissions) must
    // not block the per-run `stitch_url.txt` from being written, so
    // it's its own try/catch — but it should fire first so the cross-
    // run state catches the latest URL even if writing the per-run
    // file later fails for unrelated reasons.
    try {
      await writeStitchRef(ctx.root, {
        projectUrl: parsed.stitch_url.trim(),
        lastRunId: ctx.runId,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      ctx.logger.warn("failed to persist .mill/stitch.json", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
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
