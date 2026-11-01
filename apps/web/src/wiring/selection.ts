import { parseSelectionId } from "../city/interaction/selection.ts";
import type { DataStore } from "../data/store.ts";
import type { Selector } from "../overlays/host/index.ts";

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
