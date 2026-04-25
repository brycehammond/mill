import type { RunContext, StageResult } from "../../core/index.js";
import { designArchitecture } from "./design.arch.js";
import { designUi } from "./design.ui.js";

export async function design(ctx: RunContext): Promise<StageResult> {
  ctx.store.startStage(ctx.runId, "design");
  try {
    const kind = ctx.kind;
    if (!kind) throw new Error("design: run.kind not set");

    const result =
      kind === "ui" ? await designUi(ctx) : await designArchitecture(ctx);

    // cost, usage, and session are persisted incrementally by runClaude
    // inside designUi / designArchitecture. Finalize the stage row here.
    ctx.store.finishStage(ctx.runId, "design", {
      status: result.ok ? "completed" : "failed",
      artifact_path:
        kind === "ui" ? ctx.paths.designIntent : ctx.paths.architecture,
      error: result.ok ? null : (result.error ?? "design failed"),
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.store.finishStage(ctx.runId, "design", {
      status: "failed",
      error: msg,
    });
    return { ok: false, error: msg };
  }
}
