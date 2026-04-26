import { EventEmitter } from "node:events";
import type { EventRow } from "./types.js";

// In-process fanout for events written to the central DB. The SQLite
// `events` table is the durable source of truth; this bus is purely a
// real-time fanout for SSE subscribers running in the same daemon
// process. Subscribers re-attach across restarts via Last-Event-ID
// catch-up against the table — if the bus drops a fire (it shouldn't),
// the next replay window picks it up.
//
// Per-run channel names keep listener counts low and avoid scanning
// every event for unrelated subscribers. Node's default max listeners
// (10) would also fire warnings on a busy run; we bump it.

const bus = new EventEmitter();
bus.setMaxListeners(0);

function channel(runId: string): string {
  return `run:${runId}`;
}

export function publishRunEvent(row: EventRow): void {
  bus.emit(channel(row.run_id), row);
}

export type RunEventListener = (row: EventRow) => void;

// Subscribe to events for a single run. Returns the unsubscribe
// function — callers (SSE handlers) must invoke it on disconnect to
// avoid leaks.
export function subscribeToRunEvents(
  runId: string,
  listener: RunEventListener,
): () => void {
  const ch = channel(runId);
  bus.on(ch, listener);
  return () => {
    bus.off(ch, listener);
  };
}

export function runEventListenerCount(runId: string): number {
  return bus.listenerCount(channel(runId));
}
