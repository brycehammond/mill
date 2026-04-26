import { useEffect, useRef, useState } from "react";
import type { WireEvent } from "./types.js";

// Thin wrapper around EventSource keyed on runId. EventSource handles
// auto-reconnect and Last-Event-ID replay natively; the daemon emits
// frames without a named `event:` field so every message routes
// through onmessage. The payload's `kind` discriminates handler logic
// on the consumer side.

const RECENT_CAP = 500;

export interface SseState {
  events: WireEvent[];
  status: "connecting" | "open" | "closed" | "error";
  lastEventId: number | null;
}

export function useRunEventStream(runId: string | null): SseState {
  const [state, setState] = useState<SseState>({
    events: [],
    status: runId ? "connecting" : "closed",
    lastEventId: null,
  });
  const bufRef = useRef<WireEvent[]>([]);

  useEffect(() => {
    if (!runId) {
      setState({ events: [], status: "closed", lastEventId: null });
      return;
    }
    bufRef.current = [];
    setState({ events: [], status: "connecting", lastEventId: null });

    const url = `/api/v1/runs/${encodeURIComponent(runId)}/events`;
    const es = new EventSource(url);

    es.onopen = () => setState((s) => ({ ...s, status: "open" }));

    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(ev.data) as WireEvent;
        const next = bufRef.current.concat(parsed);
        if (next.length > RECENT_CAP) {
          next.splice(0, next.length - RECENT_CAP);
        }
        bufRef.current = next;
        setState((s) => ({
          events: next,
          status: s.status === "error" ? "open" : s.status,
          lastEventId: parsed.id,
        }));
      } catch {
        // skip malformed frame
      }
    };

    es.onerror = () => setState((s) => ({ ...s, status: "error" }));

    return () => {
      es.close();
    };
  }, [runId]);

  return state;
}
