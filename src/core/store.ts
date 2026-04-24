// Re-export so downstream imports read `@mill/core/store` naturally.
export { SqliteStateStore } from "./store.sqlite.js";
export type { StateStore } from "./types.js";

import { SqliteStateStore } from "./store.sqlite.js";
import type { StateStore } from "./types.js";
import { projectDbPath } from "./project.js";

// `root` is the project root (directory containing `.mill/`). The DB
// lives at `.mill/mill.db`; callers should have already run
// `mill init` to create it (SqliteStateStore.init() then lays down the
// schema idempotently).
export function openStore(root: string): StateStore {
  const path = projectDbPath(root);
  const s = new SqliteStateStore(path);
  s.init();
  return s;
}
