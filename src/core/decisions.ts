// Per-project decision log (ADR-lite). Appended to by a sub-stage
// that runs after deliver. Spec and design (edit-mode) read the tail
// and inject it so future runs don't quietly revert design trade-offs
// that were already debated. Lives at `.df/decisions.md`; entries
// separated by `\n---\n` so they can be tailed by splitting.
//
// Relationship to the other memory files:
//   - journal.md  — what happened on each run (activity log)
//   - ledger      — what keeps getting flagged (recurring findings)
//   - decisions.md — what we decided and why (resolved design debates)

import { readFile, appendFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { projectDfDir } from "./project.js";

export interface DecisionEntry {
  isoDate: string;
  title: string;
  context: string;
  decision: string;
  alternatives: string;
  why: string;
  trigger: string;
  runId: string;
}

const DELIMITER = "\n---\n";

export function decisionsPath(root: string): string {
  return join(projectDfDir(root), "decisions.md");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readDecisions(root: string): Promise<string> {
  const p = decisionsPath(root);
  if (!(await fileExists(p))) return "";
  return readFile(p, "utf8");
}

// Returns the tail of the decision log as a prompt-ready block, or ""
// if none exist yet. Prefixed with a header so spec/design prompts can
// include it verbatim.
export async function readDecisionsTail(
  root: string,
  n = 10,
): Promise<string> {
  const raw = await readDecisions(root);
  if (!raw.trim()) return "";
  const stanzas = raw.split(DELIMITER).map((s) => s.trim()).filter(Boolean);
  const tail = stanzas.slice(-n);
  if (tail.length === 0) return "";
  return `## Prior design decisions on this repo\n\nThese are design trade-offs already weighed on prior runs. Don't silently reverse them — if a change requires overturning one, say so explicitly.\n\n${tail.join(DELIMITER)}\n`;
}

export async function appendDecisionEntries(
  root: string,
  entries: DecisionEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const p = decisionsPath(root);
  const rendered = entries.map(formatEntry).map((s) => s.trim()).join(DELIMITER);
  const exists = await fileExists(p);
  if (!exists) {
    await writeFile(p, rendered + "\n", "utf8");
    return;
  }
  await appendFile(p, DELIMITER + rendered + "\n", "utf8");
}

function formatEntry(e: DecisionEntry): string {
  const date = e.isoDate.slice(0, 10);
  return [
    `## ${date} · ${e.title}`,
    ``,
    `**Context**: ${e.context}`,
    ``,
    `**Decision**: ${e.decision}`,
    ``,
    `**Alternatives considered**: ${e.alternatives}`,
    ``,
    `**Why**: ${e.why}`,
    ``,
    `**Trigger**: ${e.trigger}`,
    ``,
    `_Run: ${e.runId}_`,
    ``,
  ].join("\n");
}
