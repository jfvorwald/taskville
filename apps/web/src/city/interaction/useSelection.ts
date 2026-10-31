import { useMemo, useSyncExternalStore } from "react";
import type { OverlaySelection } from "../../overlays/host/types.ts";
import { type SelectionStore, selectionStore } from "./selection.ts";

/**
 * The overlay host's `selection` prop, backed by the city's selection store. Clicking an agent
 * or building in the city updates `selectedId`; an overlay calling `select` updates the city.
 */
export function useSelection(store: SelectionStore = selectionStore): OverlaySelection {
  const selectedId = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(() => ({ selectedId, select: store.select }), [selectedId, store]);
}
