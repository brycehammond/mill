// Re-export so downstream imports read `@mill/core/store` naturally.
export { SqliteStateStore } from "./store.sqlite.js";
export type { StateStore } from "./types.js";

import { SqliteStateStore } from "./store.sqlite.js";
import type { StateStore } from "./types.js";
import { centralDbPath } from "./paths.js";

// Open a SqliteStateStore at the given DB path. Phase 1 of multi-project
// mill: the canonical mill DB lives at `~/.mill/mill.db`. Pass either an
// explicit path (tests, migration tools) or omit to use the central DB.
export function openStore(dbPath?: string): StateStore {
  const path = dbPath ?? centralDbPath();
  const s = new SqliteStateStore(path);
  s.init();
  return s;
}
