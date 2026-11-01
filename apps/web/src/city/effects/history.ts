export interface PlayedEntry {
  kind: string;
  at: number;
}

export interface PlayedHistory {
  push(entry: PlayedEntry): void;
  /** Oldest first. */
  entries(): ReadonlyArray<PlayedEntry>;
}

/** The debug probe only needs recent entries; pushes happen on every celebration, so keep it bounded. */
export const PLAYED_HISTORY_LIMIT = 64;

export function createPlayedHistory(limit = PLAYED_HISTORY_LIMIT): PlayedHistory {
  const items: PlayedEntry[] = [];
  return {
    push(entry) {
      items.push(entry);
      if (items.length > limit) items.shift();
    },
    entries: () => items,
  };
}
