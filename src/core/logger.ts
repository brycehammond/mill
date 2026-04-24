import type { Logger } from "./types.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function levelFromEnv(): Level {
  const v = (process.env.MILL_LOG_LEVEL ?? "info").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_ORDER[levelFromEnv()];

  const log = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...bindings,
      ...(meta ?? {}),
    };
    const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + "\n");
  };

  return {
    debug: (m, meta) => log("debug", m, meta),
    info: (m, meta) => log("info", m, meta),
    warn: (m, meta) => log("warn", m, meta),
    error: (m, meta) => log("error", m, meta),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}
