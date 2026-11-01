import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { readSseFrames } from "../../data/sse.ts";
import { backoffMs } from "../../data/sync.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";
import { useSession } from "../../pairing/session.tsx";
import {
  type AttentionFeed,
  applyAttentionFrame,
  EMPTY_ATTENTION_FEED,
  selectAttentionHeader,
} from "./attention.ts";

// Keeps the attention feed in step with the engine: one `fetch` stream of
// `GET /v1/attention/events`, no polling. The feed has no ids and no resume, so every
// (re)connection starts with a snapshot that replaces what was held.

export interface AttentionState {
  feed: AttentionFeed;
  /** False until the first snapshot; what a notification must not treat as new. */
  ready: boolean;
}

export type AttentionStore = StoreApi<AttentionState>;

export function createAttentionStore(): AttentionStore {
  return createStore<AttentionState>()(() => ({ feed: EMPTY_ATTENTION_FEED, ready: false }));
}

/** The app-wide store. Tests and tools build their own with `createAttentionStore`. */
export const attentionStore: AttentionStore = createAttentionStore();

export interface AttentionSyncOptions {
  store: AttentionStore;
  /** The paired session secret (`useSession()`), sent as `X-Taskville-Session`. */
  secret: string;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Waits `ms`, or rejects on abort. Default is an abortable timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface AttentionSync {
  /** Stops the loop and cancels the open request. Resolves once the loop has exited. */
  stop(): Promise<void>;
}

export function startAttentionSync(options: AttentionSyncOptions): AttentionSync {
  const controller = new AbortController();
  const done = run(options, controller.signal);
  return {
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

async function run(options: AttentionSyncOptions, signal: AbortSignal): Promise<void> {
  const { store, secret } = options;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? abortableSleep;
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const response = await doFetch("/v1/attention/events", {
        headers: { [SESSION_HEADER]: secret, Accept: "text/event-stream" },
        signal,
      });
      if (signal.aborted) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      // An unpaired session cannot be fixed by retrying; the pairing flow owns that.
      if (response.status === 401) return;
      if (response.ok && response.body !== null) {
        for await (const raw of readSseFrames(response.body, signal)) {
          if (signal.aborted) return;
          const frame = parse(raw.event, raw.data);
          if (frame === undefined) continue;
          attempt = 0;
          const { feed } = store.getState();
          const next = applyAttentionFrame(feed, frame);
          if (frame.event === "snapshot") store.setState({ feed: next, ready: true });
          else if (next !== feed) store.setState({ feed: next });
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    try {
      await sleep(backoffMs(attempt), signal);
    } catch {
      return;
    }
    attempt += 1;
  }
}

function parse(event: string | undefined, data: string | undefined) {
  if (event === undefined || data === undefined) return undefined;
  try {
    return { event, data: JSON.parse(data) as unknown };
  } catch {
    return undefined;
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs the feed while mounted. Mount once, under a paired app (it reads the session). */
export function useAttentionSync(store: AttentionStore = attentionStore): void {
  const secret = useSession();
  useEffect(() => {
    const sync = startAttentionSync({ store, secret });
    return () => {
      void sync.stop();
    };
  }, [store, secret]);
}

/** The feed as the header reads it. Re-renders only when the chips or the total change. */
export function useAttentionFeed(store: AttentionStore = attentionStore): AttentionFeed {
  return useStore(store, (s) => s.feed);
}

/** Agents that need you across every project, for the tab title. A number, so it is cheap to select. */
export function useNeedsYouTotal(store: AttentionStore = attentionStore): number {
  return useStore(store, (s) => selectAttentionHeader(s.feed, null).needsYouTotal);
}
