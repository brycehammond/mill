// Re-export so downstream imports read `@df/core/store` naturally.
export { SqliteStateStore } from "./store.sqlite.js";
export type { StateStore } from "./types.js";

import { resolve } from "node:path";
import { SqliteStateStore } from "./store.sqlite.js";
import type { StateStore } from "./types.js";

export function openStore(root: string): StateStore {
  const path = resolve(root, "runs", "dark-factory.db");
  const s = new SqliteStateStore(path);
  s.init();
  return s;
}
