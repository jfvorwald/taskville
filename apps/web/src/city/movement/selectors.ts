import type { DataStore } from "../../data/store.ts";
import type { AgentCounts, Selector } from "../../overlays/host/types.ts";
import { agentCounts } from "./models.ts";

/** The header's `counts` selector over the data store; same reference until the counts change. */
export function countsSelector(store: DataStore): Selector<AgentCounts> {
  let agents = store.getState().agents;
  let counts = store.getState().counts;
  let value = agentCounts(agents, counts);
  return {
    subscribe: (listener) => store.subscribe(listener),
    getSnapshot() {
      const s = store.getState();
      if (s.agents !== agents || s.counts !== counts) {
        agents = s.agents;
        counts = s.counts;
        const next = agentCounts(agents, counts);
        if (next.active !== value.active || next.needsYou !== value.needsYou) value = next;
      }
      return value;
    },
  };
}
