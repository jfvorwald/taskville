import { useMemo, useSyncExternalStore } from "react";
import { getSettingsStore, type SettingsStore } from "../../../overlays/settings/store.ts";

// M5.13: the "Strict teammate attribution" option (decision #120 D2, ARCHITECTURE 2.9). Strict
// drops what M2.04 marked heuristic and nothing it recorded.

/** The slice of the domain the crew layer reads; extra fields on the input pass through. */
export interface AttributableView {
  readonly agents: Readonly<Record<string, object>>;
  readonly teams: unknown;
  readonly attention: readonly object[];
}

/**
 * Strict off returns the input itself. Strict on returns a copy without heuristic attention
 * records and without any agent's guessed identity; recorded fields are never touched.
 */
export function applyStrictAttribution<V extends AttributableView>(view: V, strict: boolean): V {
  if (!strict) return view;
  const agents: Record<string, object> = {};
  for (const [id, agent] of Object.entries(view.agents)) {
    if ("heuristic" in agent) {
      const { heuristic: _guess, ...recorded } = agent;
      agents[id] = recorded;
    } else {
      agents[id] = agent;
    }
  }
  const attention = view.attention.filter(
    (record) => (record as { heuristic?: unknown }).heuristic !== true,
  );
  return { ...view, agents, attention } as V;
}

/** The view after the viewer's strictness setting, re-computed only when it or the view changes. */
export function useAttributedView<V extends AttributableView>(
  view: V,
  store: SettingsStore = getSettingsStore(),
): [V] extends [never] ? AttributableView : V {
  const { strictAttribution } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return useMemo(
    () => applyStrictAttribution(view, strictAttribution),
    [view, strictAttribution],
  ) as [V] extends [never] ? AttributableView : V;
}
