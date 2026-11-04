// M5.04: the hand-off from a clicked envelope to the agent panel. The city writes the request, the
// panel reads it to open the Live feed. Its own tiny store, like the selection and highlight stores.

export interface FeedFocusRequest {
  readonly agentId: string;
  readonly eventId: string;
}

export interface FeedFocus {
  request(agentId: string, eventId: string): void;
  /** Remembers when a message event happened, for a panel that was not open to see it. */
  note(eventId: string, occurredAt: number): void;
  /** When `eventId` happened, if the city saw it. */
  occurredAt(eventId: string): number | undefined;
  getSnapshot(): FeedFocusRequest | null;
  subscribe(listener: () => void): () => void;
}

const MAX_NOTED = 200;

export function createFeedFocus(): FeedFocus {
  let current: FeedFocusRequest | null = null;
  const listeners = new Set<() => void>();
  const times = new Map<string, number>();
  return {
    note(eventId, occurredAt) {
      times.set(eventId, occurredAt);
      if (times.size > MAX_NOTED) times.delete(times.keys().next().value as string);
    },
    occurredAt: (eventId) => times.get(eventId),
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
