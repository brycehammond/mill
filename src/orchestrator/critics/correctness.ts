import type { RunContext } from "../../core/index.js";
import { runCritic, type CriticResult } from "./shared.js";

export function correctnessCritic(args: {
  ctx: RunContext;
  iteration: number;
  specBody: string;
  designBody: string;
}): Promise<CriticResult> {
  return runCritic({ ...args, critic: "correctness" });
}
