import { childIdsOf } from "../../../overlays/agent-panel/crew/crewRows.ts";
import type { FamilyAgent, FamilyTeams } from "../../../overlays/agent-panel/shell/family.ts";

export interface HighlightInput {
  /** The agent whose Crew tab is open, or null when no Crew tab is open. */
  openAgentId: string | null;
  hoveredId?: string | null | undefined;
  agents: Readonly<Record<string, FamilyAgent>>;
  teams?: FamilyTeams | undefined;
}

export interface HighlightState {
  active: boolean;
  parentId: string | null;
  childIds: string[];
  familyIds: string[];
  dimmedIds: string[];
  tethers: { from: string; to: string }[];
  bounceId: string | null;
}

const INACTIVE: HighlightState = {
  active: false,
  parentId: null,
  childIds: [],
  familyIds: [],
  dimmedIds: [],
  tethers: [],
  bounceId: null,
};

/** What the city shows while a Crew tab is open: the family kept bright, everyone else dimmed. */
export function highlightState({
  openAgentId,
  hoveredId,
  agents,
  teams,
}: HighlightInput): HighlightState {
  if (openAgentId === null || !Object.hasOwn(agents, openAgentId)) return INACTIVE;
  const childIds = childIdsOf(openAgentId, agents as Record<string, never>, teams);
  if (childIds.length === 0) return INACTIVE;
  const familyIds = [openAgentId, ...childIds];
  const family = new Set(familyIds);
  return {
    active: true,
    parentId: openAgentId,
    childIds,
    familyIds,
    dimmedIds: Object.keys(agents)
      .filter((id) => !family.has(id))
      .sort(),
    tethers: childIds.map((to) => ({ from: openAgentId, to })),
    bounceId: hoveredId != null && family.has(hoveredId) ? hoveredId : null,
  };
}

/** The camera target moves to the agent; zoom is never changed by a click. */
export function easeCameraTo(
  view: { x: number; z: number; zoom: number },
  target: { x: number; z: number },
): { x: number; z: number; zoom: number } {
  return { x: target.x, z: target.z, zoom: view.zoom };
}
