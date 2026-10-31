// A connected viewer: one fetch-streamed SSE subscription, as the web client reads it.
import { readSse } from "../../apps/cli/src/sse.ts";
import type { StoredEnvelope } from "../../packages/protocol/src/index.ts";
import type { RunningEngine } from "./engine.ts";

/** Source keys the latency check waits for start with this. */
export const PROBE_PREFIX = "probe-";

export interface Viewer {
  /** Events received so far, in order. */
  readonly received: number;
  readonly lastId: number;
  /** Ingest sequences that arrived out of order or twice (should stay 0). */
  readonly anomalies: number;
  /** Resolves with performance.now() when the event with this source key arrives. */
  arrival(sourceEventId: string): Promise<number>;
  /** Resolves once the viewer has the event with this ingest sequence. */
  reach(sequence: number): Promise<void>;
  close(): void;
}

export async function connectViewer(
  engine: RunningEngine,
  projectId: string,
  after: number,
): Promise<Viewer> {
  const abort = new AbortController();
  const res = await engine.get(`/v1/projects/${projectId}/events?after=${after}`, {
    signal: abort.signal,
  });
  if (res.status !== 200 || !res.body) throw new Error(`stream answered ${res.status}`);
  const waiting = new Map<string, (at: number) => void>();
  const arrived = new Map<string, number>();
  const reachers: { sequence: number; done: () => void }[] = [];
  const state = { received: 0, lastId: after, anomalies: 0 };

  void (async () => {
    try {
      for await (const frame of readSse(res.body as ReadableStream<Uint8Array>)) {
        if (frame.event !== "event") continue;
        const at = performance.now();
        const event = JSON.parse(frame.data) as StoredEnvelope;
        if (event.ingestSequence !== state.lastId + 1) state.anomalies += 1;
        state.lastId = event.ingestSequence;
        state.received += 1;
        const resolve = waiting.get(event.sourceEventId);
        if (resolve) {
          waiting.delete(event.sourceEventId);
          resolve(at);
        } else if (event.sourceEventId.startsWith(PROBE_PREFIX)) {
          // Only probes are awaited; other events (the demo's) are not kept.
          arrived.set(event.sourceEventId, at);
        }
        for (let i = reachers.length - 1; i >= 0; i--) {
          const r = reachers[i];
          if (r && r.sequence <= state.lastId) {
            reachers.splice(i, 1);
            r.done();
          }
        }
      }
    } catch {
      // Aborted by close().
    }
  })();

  return {
    get received() {
      return state.received;
    },
    get lastId() {
      return state.lastId;
    },
    get anomalies() {
      return state.anomalies;
    },
    arrival(sourceEventId) {
      const at = arrived.get(sourceEventId);
      if (at !== undefined) {
        arrived.delete(sourceEventId);
        return Promise.resolve(at);
      }
      return new Promise((done) => waiting.set(sourceEventId, done));
    },
    reach(sequence) {
      if (state.lastId >= sequence) return Promise.resolve();
      return new Promise((done) => reachers.push({ sequence, done }));
    },
    close: () => abort.abort(),
  };
}
