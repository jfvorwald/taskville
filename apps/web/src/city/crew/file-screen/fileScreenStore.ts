export interface FileScreenState {
  agentId: string | null;
  path: string | null;
}

const NONE: FileScreenState = { agentId: null, path: null };
let state = NONE;
const listeners = new Set<() => void>();

/**
 * What the file screen shows: the selected agent and its current file. The file screen overlay
 * writes it and the agent labels layer renders it, so the screen and the name tags are placed by
 * one collision layer and never overlap.
 */
export const fileScreenStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => state,
  set(next: FileScreenState) {
    if (next.agentId === state.agentId && next.path === state.path) return;
    state = next.agentId === null ? NONE : next;
    for (const listener of listeners) listener();
  },
};
