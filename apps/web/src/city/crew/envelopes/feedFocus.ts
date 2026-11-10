// M5.04: the hand-off from a clicked envelope to the agent panel. The city writes the request, the
// panel reads it to open the Live feed. Its own tiny store, like the selection and highlight stores.

export interface FeedFocusRequest {
  readonly agentId: string;
  readonly eventId: string;
  /** The SendMessage tool-call id of the clicked message, when its event carried one. */
  readonly toolCallId?: string;
}

export interface FeedFocus {
  request(agentId: string, eventId: string, toolCallId?: string): void;
  /** Drops `request` once the panel has used it, so a later mount does not apply it again. */
  clear(request: FeedFocusRequest): void;
  /** Milliseconds since `request` was made (Infinity for one this store did not make). */
  ageOf(request: FeedFocusRequest): number;
  getSnapshot(): FeedFocusRequest | null;
  subscribe(listener: () => void): () => void;
}

/** A request older than this is stale: the click it came from is long past. */
export const FEED_REQUEST_TTL_MS = 5000;

export function createFeedFocus(): FeedFocus {
  let current: FeedFocusRequest | null = null;
  const listeners = new Set<() => void>();
  const madeAt = new WeakMap<FeedFocusRequest, number>();
  return {
    // Every request is a new snapshot, so asking again for the same message still reaches the panel.
    request(agentId, eventId, toolCallId) {
      current = { agentId, eventId, ...(toolCallId === undefined ? {} : { toolCallId }) };
      madeAt.set(current, Date.now());
      for (const listener of [...listeners]) listener();
    },
    clear(request) {
      if (current !== request) return;
      current = null;
      for (const listener of [...listeners]) listener();
    },
    ageOf: (request) => {
      const at = madeAt.get(request);
      return at === undefined ? Number.POSITIVE_INFINITY : Date.now() - at;
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
