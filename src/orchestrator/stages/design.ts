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

    const sessionId =
      (result.data as { sessionId?: string } | undefined)?.sessionId;
    const cost = result.cost ?? 0;

    ctx.store.transaction(() => {
      ctx.store.addRunCost(ctx.runId, cost);
      if (sessionId) {
        ctx.store.saveSession(ctx.runId, "design", sessionId, cost);
      }
      ctx.store.finishStage(ctx.runId, "design", {
        status: result.ok ? "completed" : "failed",
        cost_usd: cost,
        session_id: sessionId ?? null,
        artifact_path:
          kind === "ui" ? ctx.paths.designIntent : ctx.paths.architecture,
        error: result.ok ? null : (result.error ?? "design failed"),
      });
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
