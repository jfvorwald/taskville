// M5.04: the hand-off from a clicked envelope to the agent panel. The city writes the request, the
// panel reads it to open the Live feed. Its own tiny store, like the selection and highlight stores.

export interface FeedFocusRequest {
  readonly agentId: string;
  readonly eventId: string;
}

export interface FeedFocus {
  request(agentId: string, eventId: string): void;
  getSnapshot(): FeedFocusRequest | null;
  subscribe(listener: () => void): () => void;
}

export function createFeedFocus(): FeedFocus {
  let current: FeedFocusRequest | null = null;
  const listeners = new Set<() => void>();
  return {
    // Every request is a new snapshot, so asking again for the same message still reaches the panel.
    request(agentId, eventId) {
      current = { agentId, eventId };
      for (const listener of [...listeners]) listener();
    },
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The app-wide feed focus. */
export const feedFocus: FeedFocus = createFeedFocus();
