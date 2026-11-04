/**
 * Which agent's Crew tab is open and which crew row is under the pointer. The panel writes it, the
 * city reads it. Its own tiny store, like the selection store, so neither side imports the other.
 */
export interface HighlightInputs {
  readonly openAgentId: string | null;
  readonly hoveredId: string | null;
}

export interface HighlightStore {
  getSnapshot(): HighlightInputs;
  subscribe(listener: () => void): () => void;
  open(agentId: string | null): void;
  hover(agentId: string | null): void;
}

export function createHighlightStore(): HighlightStore {
  let current: HighlightInputs = { openAgentId: null, hoveredId: null };
  const listeners = new Set<() => void>();
  const set = (next: HighlightInputs) => {
    if (next.openAgentId === current.openAgentId && next.hoveredId === current.hoveredId) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // Closing the tab also drops the hover: the pointer row is gone with it.
    open: (agentId) =>
      set({ openAgentId: agentId, hoveredId: agentId === null ? null : current.hoveredId }),
    hover: (agentId) => set({ openAgentId: current.openAgentId, hoveredId: agentId }),
  };
}

/** The app-wide highlight inputs. */
export const highlightStore: HighlightStore = createHighlightStore();
