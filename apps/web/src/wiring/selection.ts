import type { SelectionStore } from "../city/interaction/selection.ts";
import { parseSelectionId } from "../city/interaction/selection.ts";
import type { DataStore } from "../data/store.ts";
import type { OverlaySelection, Selector } from "../overlays/host/index.ts";

/**
 * The overlay host's `selection` over the city's selection store, so the selector and the host
 * share one source. `select` keeps its identity; the snapshot changes only with the selection.
 */
export function overlaySelection(store: SelectionStore): Selector<OverlaySelection> {
  let snapshot: OverlaySelection = { selectedId: store.getSnapshot(), select: store.select };
  return {
    subscribe: store.subscribe,
    getSnapshot() {
      const selectedId = store.getSnapshot();
      if (selectedId !== snapshot.selectedId) snapshot = { selectedId, select: store.select };
      return snapshot;
    },
  };
}

/**
 * Mirrors agent selections into the data store's `selectedAgentId` (now and on change). Area
 * selections are ignored: they name a building, not an agent. Returns the disposer.
 */
export function connectSelectedAgent({
  selection,
  data,
}: {
  selection: Selector<string | null>;
  data: Pick<DataStore, "getState">;
}) {
  const apply = () => {
    const parsed = parseSelectionId(selection.getSnapshot());
    if (parsed === null) data.getState().select(null);
    else if (parsed.kind === "agent") data.getState().select(parsed.id);
  };
  apply();
  return selection.subscribe(apply);
}
