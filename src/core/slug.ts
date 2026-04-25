// Derive a short, human-meaningful kebab-case slug from a free-form
// requirement. Used at intake time to name the edit-mode worktree
// branch — `mill/<slug>-<shortId>` is far more grokkable in `git
// branch -a` than the raw run id.
//
// Trade-offs taken:
//  - We don't have a spec title at intake (clarify runs after), so the
//    only signal is the requirement text itself.
//  - Biographical preambles ("I am a 46 year old who…", "As a frontend
//    dev I want…") get skipped if a later sentence carries the actual
//    intent. Otherwise we fall back to the first sentence.
//  - Stop words are filtered to keep the slug content-bearing. Action
//    verbs (add, build, fix, …) are intentionally NOT filtered — they
//    usually anchor the meaning.
//  - Output is git-branch-safe by construction (alphanumeric + single
//    hyphens, no leading hyphen, no trailing hyphen).
//  - Returns "" on degenerate input so the caller can fall back to
//    `run-<runId>` rather than producing an empty branch component.

const BIOGRAPHICAL_PREFIX = /^(i\s+am|i'm|as\s+(a|an|the)|hi|hello)\b/i;

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "to", "of",
  "in", "on", "at", "for", "with", "from", "by", "about", "as",
  "is", "am", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must",
  "can", "shall",
  "this", "that", "these", "those",
  "i", "my", "me", "we", "us", "our", "you", "your", "they", "them",
  "their", "it", "its", "he", "she", "his", "her",
  "so", "such", "than", "very", "just", "also", "too",
  "want", "wants", "wanting", "need", "needs", "needing",
  "would", "should",
  "please", "kindly",
]);

const MAX_SLUG_LEN = 40;

export function slugifyRequirement(text: string): string {
  const sentence = pickMeaningfulSentence(text);
  const tokens = sentence
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  if (tokens.length === 0) return "";

  let slug = "";
  for (const t of tokens) {
    const next = slug ? `${slug}-${t}` : t;
    if (next.length > MAX_SLUG_LEN) {
      // First token alone exceeds the cap — accept the truncated form
      // rather than returning empty.
      if (!slug) return t.slice(0, MAX_SLUG_LEN);
      break;
    }
    slug = next;
  }
  return slug;
}

function pickMeaningfulSentence(text: string): string {
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sentences) {
    if (!BIOGRAPHICAL_PREFIX.test(s)) return s.slice(0, 200);
  }
  return (sentences[0] ?? text).slice(0, 200);
}
