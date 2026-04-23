// Per-project journal of df activity. One stanza per completed run,
// appended by the deliver stage. Spec and design stages read the tail
// and inject it into their prompts so successive runs build on prior
// context. Stored as markdown at `.df/journal.md`; entries are
// separated by `\n---\n` so they can be tailed by splitting on that
// delimiter.

import { readFile, appendFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { projectDfDir } from "./project.js";
import type { RunMode } from "./types.js";

export interface JournalEntry {
  runId: string;
  mode: RunMode;
  isoDate: string;
  requirementFirstLine: string;
  branch: string | null;
  verify: "pass" | "fail";
  costUsd: number;
}

const DELIMITER = "\n---\n";

export function journalPath(root: string): string {
  return join(projectDfDir(root), "journal.md");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJournal(root: string): Promise<string> {
  const p = journalPath(root);
  if (!(await fileExists(p))) return "";
  return readFile(p, "utf8");
}

// Returns the tail of the journal as a prompt-ready block, or "" if
// the journal does not yet exist. The block is prefixed with a header
// so spec/design prompts can include it verbatim.
export async function readJournalTail(root: string, n = 20): Promise<string> {
  const raw = await readJournal(root);
  if (!raw.trim()) return "";
  const stanzas = raw.split(DELIMITER).map((s) => s.trim()).filter(Boolean);
  const tail = stanzas.slice(-n);
  if (tail.length === 0) return "";
  return `## Prior df activity on this repo\n\n${tail.join(DELIMITER)}\n`;
}

export async function appendJournalEntry(
  root: string,
  entry: JournalEntry,
): Promise<void> {
  const p = journalPath(root);
  const stanza = formatEntry(entry);
  const exists = await fileExists(p);
  if (!exists) {
    await writeFile(p, stanza.trim() + "\n", "utf8");
    return;
  }
  await appendFile(p, DELIMITER + stanza.trim() + "\n", "utf8");
}

function formatEntry(e: JournalEntry): string {
  const branchLine = e.branch ? `- **Branch**: \`${e.branch}\`\n` : "";
  return [
    `### ${e.runId} · ${e.mode} · ${e.verify === "pass" ? "✅" : "⚠️"}`,
    ``,
    `- **Date**: ${e.isoDate}`,
    `- **Requirement**: ${e.requirementFirstLine}`,
    branchLine.trim(),
    `- **Cost**: $${e.costUsd.toFixed(4)}`,
    ``,
  ]
    .filter((l) => l !== null)
    .join("\n");
}
