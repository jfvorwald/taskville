import type { Selector } from "../../overlays/host/types.ts";

/**
 * What the user has selected in the city: an agent id, or `area:<id>` for a building. Kept in
 * its own tiny store (the M3.02 data store's shape is not changed) and exposed as an overlay
 * `Selector`, so a DOM overlay and the 3D scene read the same value.
 */
export interface SelectionStore extends Selector<string | null> {
  select(id: string | null): void;
}

export function createSelectionStore(initial: string | null = null): SelectionStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select(id) {
      if (id === current) return;
      current = id;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The app-wide selection. */
export const selectionStore: SelectionStore = createSelectionStore();

const AREA_PREFIX = "area:";

export function areaSelectionId(areaId: string): string {
  return `${AREA_PREFIX}${areaId}`;
}

export type ParsedSelection = { kind: "agent" | "area"; id: string };

export function parseSelectionId(id: string | null): ParsedSelection | null {
  if (id === null) return null;
  if (id.startsWith(AREA_PREFIX)) return { kind: "area", id: id.slice(AREA_PREFIX.length) };
  return { kind: "agent", id };
}

/**
 * What a rescan for the selected object means. A selection can be made before its object mounts
 * (from the agent list), so nothing is cleared until the object has been seen once; after that, a
 * rescan that finds nothing means it is gone and the selection is cleared.
 */
export function selectionAfterRescan(input: { seen: boolean; found: boolean }): {
  seen: boolean;
  clear: boolean;
} {
  if (input.found) return { seen: true, clear: false };
  return { seen: false, clear: input.seen };
}
