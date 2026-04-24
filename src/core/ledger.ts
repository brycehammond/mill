// Prompt-injection helpers on top of the findings ledger. Spec and
// design (edit-mode) and implement (iter 1, edit-mode) prepend a
// compact block listing the top recurring non-suppressed findings so
// the model preempts issues that keep getting flagged on this repo.

import type { LedgerEntry, StateStore } from "./types.js";

// Render the top N recurring findings into a markdown block. Returns
// empty string if nothing qualifies. "Recurring" means seen in at
// least 2 runs (matching `df findings` default); suppressed
// fingerprints are excluded.
export function renderLedgerHint(
  store: StateStore,
  opts: { limit?: number } = {},
): string {
  const limit = opts.limit ?? 5;
  const entries = store.listLedgerEntries({
    minRuns: 2,
    includeSuppressed: false,
    limit,
  });
  if (entries.length === 0) return "";
  const lines = entries.map((e: LedgerEntry) => {
    const runs = `${e.runCount}× runs`;
    return `- **[${e.severity}] ${e.critic}: ${e.title}** — ${runs}`;
  });
  return [
    `## Recurring findings on this repo`,
    ``,
    `These issues keep getting flagged by past critics. Preempt them.`,
    ``,
    ...lines,
    ``,
  ].join("\n");
}
