import type { Selector } from "../../overlays/host/types.ts";

export interface PresentationEpoch {
  /** Counts the times the tab has come back from hidden. */
  epoch: number;
  /** How long the tab was hidden before the latest return. */
  hiddenForMs: number;
}

export interface PresentationEpochStore extends Selector<PresentationEpoch> {
  bump(hiddenForMs: number): void;
}

/**
 * Tells the agents layer that the tab has returned from hidden. `RenderPacer` bumps it;
 * `CityAgents`, which owns the navigator, subscribes and rebuilds the presentation.
 */
export function createPresentationEpoch(): PresentationEpochStore {
  let current: PresentationEpoch = { epoch: 0, hiddenForMs: 0 };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bump(hiddenForMs) {
      current = { epoch: current.epoch + 1, hiddenForMs };
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The app-wide epoch. */
export const presentationEpoch: PresentationEpochStore = createPresentationEpoch();
