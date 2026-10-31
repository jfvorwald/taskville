import { createStore, type StoreApi } from "zustand/vanilla";
import {
  type Agent,
  type Attention,
  type AttentionCounts,
  attention,
  attentionCounts,
  type ProjectState,
  reduce,
  type StoredEnvelope,
} from "./domain.ts";

/**
 * The client data store: the last known ProjectState for one project plus what the UI reads
 * from it. This is the interface other web tickets depend on; keep it small.
 *
 * Reads (stable references: a field changes identity only when its content may have changed):
 * - `agents`: every agent, in registration order (the reducer's map order).
 * - `counts`: header counts (`needsYou`, `trouble`, `waiting`).
 * - `attention`: the attention records behind the counts, most urgent first.
 * - `connection` / `error`: see {@link Connection}. A `stale` or `failed` view still shows the
 *   last known `state`; the UI marks it, never blanks it.
 * - `selectedAgentId`: navigation. Camera focus and the agent panel follow it.
 */
export type Connection =
  /** No data yet, or loading the first snapshot. */
  | "connecting"
  /** Snapshot applied and the event stream is open. */
  | "live"
  /** Disconnected; the last view is kept and being retried. */
  | "stale"
  /** Stopped for a reason retrying cannot fix; see `error`. */
  | "failed";

export type SyncError =
  /** The session secret is no longer valid: pair again. */
  | "unauthorized"
  | "unknown_project"
  /** The engine's reducer version differs from this build's: reload the page. */
  | "reducer_mismatch"
  /** The engine sent something this build cannot parse. */
  | "bad_response";

export interface DataState {
  projectId: string | null;
  /** The reduced state; null until the first snapshot. */
  state: ProjectState | null;
  /** Ingest sequence of the last applied event (the snapshot cursor at first); 0 before any. */
  cursor: number;
  connection: Connection;
  error: SyncError | null;
  agents: readonly Agent[];
  attention: readonly Attention[];
  counts: AttentionCounts;
  selectedAgentId: string | null;

  select(agentId: string | null): void;
  /** Recomputes attention against the clock; call on a timer so silence shows up unprompted. */
  refreshAttention(): void;

  // Written by the sync loop (sync.ts); not for UI code.
  reset(projectId: string): void;
  applySnapshotState(state: ProjectState): void;
  applyEvent(event: StoredEnvelope): void;
  setConnection(connection: Connection): void;
  fail(error: SyncError): void;
}

export type DataStore = StoreApi<DataState>;

export interface DataStoreOptions {
  /** Milliseconds since the epoch; attention depends on it. Default `Date.now`. */
  now?: () => number;
}

const NO_COUNTS: AttentionCounts = { needsYou: 0, trouble: 0, waiting: 0 };
const NO_AGENTS: readonly Agent[] = [];
const NO_ATTENTION: readonly Attention[] = [];

function fresh(projectId: string | null) {
  return {
    projectId,
    state: null,
    cursor: 0,
    connection: "connecting" as Connection,
    error: null,
    agents: NO_AGENTS,
    attention: NO_ATTENTION,
    counts: NO_COUNTS,
    selectedAgentId: null,
  };
}

export function createDataStore(options: DataStoreOptions = {}): DataStore {
  const now = options.now ?? Date.now;

  /** Derived fields for `next`, reusing the previous references when their inputs are unchanged. */
  function derive(prev: DataState, next: ProjectState, force = false) {
    const before = prev.state;
    const agentsSame = before !== null && before.agents === next.agents;
    const agents = agentsSame ? prev.agents : Object.values(next.agents);
    if (!force && agentsSame && before.requests === next.requests) {
      return { agents, attention: prev.attention, counts: prev.counts };
    }
    const records = attention(next, now());
    return { agents, attention: records, counts: attentionCounts(next, now()) };
  }

  return createStore<DataState>()((set) => ({
    ...fresh(null),

    select: (selectedAgentId) => set({ selectedAgentId }),

    refreshAttention: () => set((s) => (s.state === null ? s : derive(s, s.state, true))),

    reset: (projectId) => set(fresh(projectId)),

    applySnapshotState: (state) =>
      set((s) => ({ state, cursor: state.head, error: null, ...derive(s, state) })),

    applyEvent: (event) =>
      set((s) => {
        if (s.state === null) throw new Error("applyEvent before a snapshot");
        const state = reduce(s.state, event);
        return { state, cursor: state.head, ...derive(s, state) };
      }),

    setConnection: (connection) => set({ connection }),

    fail: (error) => set({ connection: "failed", error }),
  }));
}

/** The app-wide store. Tests and tools build their own with `createDataStore`. */
export const dataStore: DataStore = createDataStore();
