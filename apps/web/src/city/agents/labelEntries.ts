import { agentLabel } from "./label.ts";
import { agentScale } from "./scale.ts";
import type { AgentLabelEntry, AgentView } from "./types.ts";

/** Label height above the feet at full size, world units. Matches the rig in `resources.ts`. */
export const LABEL_HEIGHT = 1.25;

/**
 * Label text and a world anchor for each agent: the interface to the world-labels slot (M3.03).
 * `anchor` is the agent's live placement object, so the slot reads the current position when it
 * projects, and the entries need rebuilding only when text or size changes.
 */
export function buildLabelEntries(agents: readonly AgentView[]): AgentLabelEntry[] {
  return agents.map((v) => {
    const { name, status } = agentLabel(v);
    return {
      id: v.id,
      name,
      status,
      anchor: v.placement,
      offsetY: LABEL_HEIGHT * agentScale(v.kind, v.depth ?? 0),
    };
  });
}
