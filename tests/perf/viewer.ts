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

export interface ViewerOptions {
  /** A wait that is not satisfied by then rejects, so a lost event fails the check instead of hanging it. */
  waitTimeoutMs?: number;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export async function connectViewer(
  engine: RunningEngine,
  projectId: string,
  after: number,
  options: ViewerOptions = {},
): Promise<Viewer> {
  const waitTimeoutMs = options.waitTimeoutMs ?? 30_000;
  const abort = new AbortController();
  const res = await engine.get(`/v1/projects/${projectId}/events?after=${after}`, {
    signal: abort.signal,
  });
  if (res.status !== 200 || !res.body) throw new Error(`stream answered ${res.status}`);
  const waiting = new Map<string, Waiter<number>>();
  const arrived = new Map<string, number>();
  const reachers: { sequence: number; waiter: Waiter<void> }[] = [];
  const state = { received: 0, lastId: after, anomalies: 0 };
  let failure: Error | undefined;

  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    for (const waiter of waiting.values()) waiter.reject(error);
    waiting.clear();
    for (const { waiter } of reachers.splice(0)) waiter.reject(error);
  };

  /** A promise that rejects on stream failure or after the timeout. */
  const wait = <T>(register: (waiter: Waiter<T>) => () => void, what: string): Promise<T> => {
    if (failure) return Promise.reject(failure);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unregister();
        reject(new Error(`timed out after ${waitTimeoutMs} ms waiting for ${what}`));
      }, waitTimeoutMs);
      const unregister = register({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  };

  void (async () => {
    try {
      for await (const frame of readSse(res.body as ReadableStream<Uint8Array>)) {
        if (frame.event === "resnapshot") {
          fail(new Error(`viewer got resnapshot ${frame.data.match(/"reason":"(\w+)"/)?.[1]}`));
          return;
        }
        if (frame.event !== "event") continue;
        const at = performance.now();
        const event = JSON.parse(frame.data) as StoredEnvelope;
        if (event.ingestSequence !== state.lastId + 1) state.anomalies += 1;
        state.lastId = event.ingestSequence;
        state.received += 1;
        const waiter = waiting.get(event.sourceEventId);
        if (waiter) {
          waiting.delete(event.sourceEventId);
          waiter.resolve(at);
        } else if (event.sourceEventId.startsWith(PROBE_PREFIX)) {
          // Only probes are awaited; other events (the demo's) are not kept.
          arrived.set(event.sourceEventId, at);
        }
        for (let i = reachers.length - 1; i >= 0; i--) {
          const r = reachers[i];
          if (r && r.sequence <= state.lastId) {
            reachers.splice(i, 1);
            r.waiter.resolve();
          }
        }
      }
      fail(new Error("viewer stream ended"));
    } catch (error) {
      fail(abort.signal.aborted ? new Error("viewer closed") : (error as Error));
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
      return wait<number>((waiter) => {
        waiting.set(sourceEventId, waiter);
        return () => waiting.delete(sourceEventId);
      }, `event ${sourceEventId}`);
    },
    reach(sequence) {
      if (state.lastId >= sequence) return Promise.resolve();
      return wait<void>((waiter) => {
        const entry = { sequence, waiter };
        reachers.push(entry);
        return () => {
          const i = reachers.indexOf(entry);
          if (i >= 0) reachers.splice(i, 1);
        };
      }, `sequence ${sequence}`);
    },
    close: () => abort.abort(),
  };
}
