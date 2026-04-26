import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventRow, StateStore } from "../core/index.js";
import { subscribeToRunEvents } from "../core/index.js";

// Server-Sent Events handler for /api/v1/runs/:id/events. Replay-then-
// live: backfill events with id > Last-Event-ID (or ?since=) by reading
// the events table, then attach to the in-process bus for the live
// tail. Catch-up is bounded per page so a long-running run with tens of
// thousands of events doesn't block the live stream — we drain the
// backlog in batches before subscribing.
//
// Reconnect protocol: clients use EventSource, which automatically
// re-attaches on disconnect with `Last-Event-ID` set to the last event
// the client successfully received. The SQL replay closes the gap; the
// bus picks up from the new tail. There are no duplicates because
// every message carries its monotonic events.id and clients track it.
//
// Backpressure: writeSSE awaits the network write. If a subscriber
// can't keep up, the buffer between bus events and writeSSE grows; we
// guard against that by capping the in-flight queue. Past the cap,
// new bus events are dropped *for that subscriber* — the client
// reconnects via EventSource and re-replays from Last-Event-ID. SQLite
// stays the source of truth, so the dropped frames are recoverable.
//
// We do not implement a heartbeat ping. EventSource itself reconnects
// on idle disconnect, and every `appendEvent` already produces a real
// frame on a busy run. Add one if a future deployment needs to keep
// loopback connections through aggressive intermediaries.

export interface SseHandlerArgs {
  store: StateStore;
}

const REPLAY_PAGE_SIZE = 500;
const QUEUE_CAP = 1024;

export function buildSseHandler(args: SseHandlerArgs) {
  const { store } = args;
  return async (c: Context): Promise<Response> => {
    const runId = c.req.param("id");
    if (!runId) return c.text("missing run id", 400);
    const run = store.getRun(runId);
    if (!run) return c.text(`run not found: ${runId}`, 404);

    const lastIdHeader = c.req.header("last-event-id");
    const sinceQuery = c.req.query("since");
    const startAfter = parsePositiveInt(lastIdHeader) ?? parsePositiveInt(sinceQuery) ?? 0;

    return streamSSE(c, async (stream) => {
      // Subscribe before we start the catch-up so any events written
      // mid-replay are queued — we'll drain the queue after the SQL
      // backlog finishes. Without this, an event inserted between the
      // last replay page and the subscribe call would be lost.
      let queued: EventRow[] = [];
      let dropped = 0;
      const unsub = subscribeToRunEvents(runId, (row) => {
        if (queued.length >= QUEUE_CAP) {
          dropped += 1;
          return;
        }
        queued.push(row);
      });

      stream.onAbort(() => {
        unsub();
      });

      try {
        // Replay backlog from SQLite in fixed-size pages.
        let cursor = startAfter;
        // Track the highest id we've actually written so we can dedupe
        // against any rows the bus also queued during the replay.
        let highestSent = startAfter;
        // Loop until tailEvents returns an empty page.
        // tailEvents is bounded by REPLAY_PAGE_SIZE per call.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const page = store.tailEvents(runId, cursor, REPLAY_PAGE_SIZE);
          if (page.length === 0) break;
          for (const row of page) {
            await writeRow(stream, row);
            if (row.id > highestSent) highestSent = row.id;
          }
          const last = page[page.length - 1]!;
          cursor = last.id;
          if (page.length < REPLAY_PAGE_SIZE) break;
        }

        // Drain whatever the bus queued during replay, dedup on id,
        // then keep streaming until the connection drops. We use a
        // simple poll loop with a tiny sleep when the queue is empty;
        // SSE doesn't need sub-millisecond latency and this avoids
        // the complexity of an explicit promise-based queue.
        while (!stream.aborted && !stream.closed) {
          if (queued.length > 0) {
            const batch = queued;
            queued = [];
            for (const row of batch) {
              if (row.id <= highestSent) continue;
              await writeRow(stream, row);
              highestSent = row.id;
            }
            continue;
          }
          await stream.sleep(50);
        }
      } finally {
        unsub();
        if (dropped > 0) {
          // Don't try to send after the connection is already closing;
          // the next reconnect will replay from Last-Event-ID anyway.
        }
      }
    });
  };
}

async function writeRow(
  stream: { writeSSE: (m: { id?: string; event?: string; data: string }) => Promise<void> },
  row: EventRow,
): Promise<void> {
  // Intentionally omit `event:` — `kind` is already inside the JSON
  // payload, and dropping the named-event channel means every frame
  // routes through EventSource.onmessage on the client. With a named
  // event, browsers only deliver to addEventListener(name, …) which
  // forces consumers to enumerate kinds up front.
  await stream.writeSSE({
    id: String(row.id),
    data: JSON.stringify(rowToWire(row)),
  });
}

function rowToWire(row: EventRow): {
  id: number;
  run_id: string;
  stage: string;
  ts: number;
  kind: string;
  payload: unknown;
} {
  let payload: unknown = null;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    payload = row.payload_json;
  }
  return {
    id: row.id,
    run_id: row.run_id,
    stage: row.stage,
    ts: row.ts,
    kind: row.kind,
    payload,
  };
}

function parsePositiveInt(v: string | undefined | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}
