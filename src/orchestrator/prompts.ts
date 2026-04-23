import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Prompts live at src/prompts (and are copied to dist/prompts by `npm run build`).
// This file sits at src/orchestrator/prompts.ts → sibling of ../prompts.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = join(__dirname, "..", "prompts");

const cache = new Map<string, string>();

export async function loadPrompt(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const body = await readFile(join(PROMPT_DIR, `${name}.md`), "utf8");
  cache.set(name, body);
  return body;
}

export function clearPromptCache(): void {
  cache.clear();
}
