import { createStore, type StoreApi } from "zustand/vanilla";
import { type ProjectState, REDUCER_VERSION, snapshotResponseSchema } from "../../data/domain.ts";
import type { DataStore } from "../../data/store.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";
import { compressedDuration } from "../archives/archive-timelines.ts";

export type ReplayRate = 1 | 10 | 60 | 600;

export interface HistoryState {
  mode: "live" | "history";
  state: ProjectState | null;
  /** Replay clock, advancing between recorded positions independently of computedAt. */
  time: number | null;
  playing: boolean;
  rate: ReplayRate;
  seek(epochMs: number): Promise<void>;
  seekSequence(sequence: number, recordedAt: number): Promise<void>;
  play(): void;
  pause(): void;
  setRate(rate: ReplayRate): void;
  /** Drops any state read still in flight; the presented state stays as it is. */
  cancelRead(): void;
  /** Scheduling belongs to the caller. */
  tick(): Promise<void>;
  returnLive(): void;
}

export type HistoryStore = StoreApi<HistoryState> & { dispose(): void };

export interface HistoryStoreOptions {
  liveStore: DataStore;
  timelineId: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Recorded positions in order; a function when the loaded window grows or moves. */
  moments?: readonly Moment[] | (() => readonly Moment[]);
  /** Archives play long gaps compressed. */
  compressGaps?: boolean;
  /** Last sequence of the timeline when `moments` holds only a window of it. */
  lastSequence?: number;
  /** Loads the events after the window's end, so `moments` grows. */
  extend?(afterSequence: number): Promise<void>;
}

interface Moment {
  sequence: number;
  time: number;
}

export function createHistoryStore(options: HistoryStoreOptions): HistoryStore {
  const { liveStore, timelineId, secret } = options;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const projectId = liveStore.getState().projectId;
  let disposed = false;
  let generation = 0;
  let request: AbortController | undefined;
  let pendingPlayback = false;
  let elapsedAt = now();
  let target: number | null = null;
  let exact = false;
  let extending = false;
  const source = options.moments;
  let cached:
    | { from: readonly Moment[]; positions: Array<Moment & { elapsed: number }> }
    | undefined;
  /** Elapsed playback time at each moment, recomputed when the loaded moments change. */
  function positionsOf() {
    const from = typeof source === "function" ? source() : source;
    if (!from) return undefined;
    if (cached?.from === from) return cached.positions;
    let elapsed = 0;
    const positions = from.map((moment, index) => {
      const gap = index === 0 ? 0 : moment.time - (from[index - 1]?.time ?? moment.time);
      elapsed += options.compressGaps ? compressedDuration(gap) : Math.max(0, gap);
      return { ...moment, elapsed };
    });
    cached = { from, positions };
    return positions;
  }

  function cancel() {
    generation += 1;
    request?.abort();
    request = undefined;
    pendingPlayback = false;
  }

  function anchor(resetPosition = false) {
    const elapsed = now();
    if (exact && !resetPosition && target !== null) {
      if (store.getState().playing) {
        target += Math.max(0, elapsed - elapsedAt) * store.getState().rate;
        const end = positionsOf()?.at(-1)?.elapsed;
        if (end !== undefined) target = Math.min(target, end);
      }
    } else {
      target = exact
        ? (positionsOf()?.find((moment) => moment.sequence === store.getState().state?.head)
            ?.elapsed ?? null)
        : store.getState().time;
    }
    elapsedAt = elapsed;
  }

  async function seek(time: number, playback = false, sequence?: number): Promise<void> {
    if (disposed || liveStore.getState().projectId !== projectId) return;
    const at = sequence === undefined ? new Date(time).toISOString() : String(sequence);
    cancel();
    const current = generation;
    const controller = new AbortController();
    request = controller;
    pendingPlayback = playback;
    try {
      const response = await doFetch(
        `/v1/timelines/${encodeURIComponent(timelineId)}/state?at=${encodeURIComponent(at)}`,
        { headers: { [SESSION_HEADER]: secret }, signal: controller.signal },
      );
      if (current !== generation || disposed) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (current !== generation || disposed) return;
      if (typeof body !== "object" || body === null || !("timelineId" in body)) {
        throw new Error("bad_response");
      }
      const {
        timelineId: receivedTimeline,
        at: position,
        ...snapshot
      } = body as Record<string, unknown>;
      const parsed = snapshotResponseSchema.safeParse({ ...snapshot, projectId });
      if (!parsed.success || receivedTimeline !== timelineId) throw new Error("bad_response");
      const data = parsed.data;
      const state = data.state as unknown as ProjectState;
      if (data.reducerVersion !== REDUCER_VERSION || state.reducerVersion !== REDUCER_VERSION) {
        throw new Error("reducer_mismatch");
      }
      if (
        state.projectId !== projectId ||
        state.head !== data.cursor ||
        position !== data.cursor ||
        (sequence !== undefined && data.cursor !== sequence)
      ) {
        throw new Error("bad_response");
      }
      exact = sequence !== undefined;
      store.setState({ mode: "history", state, time });
      if (!playback) anchor(true);
    } catch (error) {
      if (current !== generation || disposed) return;
      anchor();
      throw error;
    } finally {
      if (current === generation) {
        request = undefined;
        pendingPlayback = false;
      }
    }
  }

  const store = createStore<HistoryState>()((set, get) => ({
    mode: "live",
    state: liveStore.getState().state,
    time: null,
    playing: false,
    rate: 1,
    seek: (time) => seek(time),
    seekSequence: (sequence, time) => {
      if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(time))
        return Promise.reject(new Error("bad_position"));
      const positions = positionsOf();
      if (
        positions &&
        !positions.some((moment) => moment.sequence === sequence && moment.time === time)
      )
        return Promise.reject(new Error("bad_position"));
      return seek(time, false, sequence);
    },
    play: () => {
      if (disposed || get().mode !== "history" || get().playing) return;
      anchor();
      set({ playing: true });
    },
    pause: () => {
      if (disposed) return;
      if (pendingPlayback) cancel();
      anchor();
      set({ playing: false });
    },
    setRate: (rate) => {
      if (disposed) return;
      if (pendingPlayback) cancel();
      anchor();
      set({ rate });
    },
    cancelRead: () => {
      if (disposed) return;
      cancel();
      anchor();
    },
    tick: async () => {
      // Leave an explicit seek or playback read in flight. The next scheduled tick includes
      // all elapsed time since the last read, so skipped ticks neither starve reads nor lose time.
      if (
        disposed ||
        request ||
        extending ||
        !get().playing ||
        get().mode !== "history" ||
        target === null
      )
        return;
      const elapsed = now();
      target += Math.max(0, elapsed - elapsedAt) * get().rate;
      elapsedAt = elapsed;
      const positions = positionsOf();
      if (exact && positions?.length) {
        const end = positions[positions.length - 1];
        if (!end) return;
        target = Math.min(target, end.elapsed);
        let moment = positions[0];
        for (const candidate of positions) {
          if (candidate.elapsed > target) break;
          moment = candidate;
        }
        if (moment) {
          const time = moment.time + target - moment.elapsed;
          if (moment.sequence !== get().state?.head) await seek(time, true, moment.sequence);
          else if (time !== get().time) set({ time });
        }
        if (get().state?.head === end.sequence) {
          if (options.lastSequence === undefined || end.sequence >= options.lastSequence)
            get().pause();
          else if (options.extend) {
            extending = true;
            try {
              await options.extend(end.sequence);
            } finally {
              extending = false;
            }
          }
        }
      } else {
        await seek(target, true);
      }
    },
    returnLive: () => {
      if (disposed) return;
      cancel();
      target = null;
      set({ mode: "live", state: liveStore.getState().state, time: null, playing: false });
    },
  }));

  const unsubscribe = liveStore.subscribe((next, previous) => {
    if (
      next.projectId !== previous.projectId ||
      next.resetGeneration !== previous.resetGeneration
    ) {
      store.getState().returnLive();
    } else if (store.getState().mode === "live") {
      store.setState({ state: next.state });
    }
  });

  return Object.assign(store, {
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      unsubscribe();
    },
  });
}
