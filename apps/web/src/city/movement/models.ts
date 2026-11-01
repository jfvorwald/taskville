import type { Agent, Attention, AttentionCounts, ProjectState } from "../../data/domain.ts";
import type { AgentCounts } from "../../overlays/host/types.ts";
import { identityKey } from "../agents/identity.ts";
import type { AgentView, AttentionView, Placement } from "../agents/types.ts";
import { troubleDetail } from "../attention/detail.ts";
import { type ActivityAreaTable, areaFor } from "./areas.ts";
import type { NavIntent, RestState } from "./navigator.ts";

// The glue between the M3.02 store and the city: domain agents, activity and attention become
// M3.05 `AgentView`s (what the bots and labels show) and navigation intents (where they go).
// Labels read the recorded state straight from here, so they change the instant an event lands.

/** The domain's per-agent activity record (not re-exported by `data/domain.ts`). */
export type AgentActivity = NonNullable<ProjectState["activity"][string]>;

export interface ModelInput {
  readonly agents: readonly Agent[];
  readonly tasks?: ProjectState["tasks"];
  readonly teams?: ProjectState["teams"];
  /** `ProjectState.activity`, keyed by agent id. */
  readonly activity: Readonly<Record<string, AgentActivity | undefined>>;
  /** Most urgent first (the store's order). */
  readonly attention: readonly Attention[];
}

export interface Models {
  readonly views: AgentView[];
  readonly intents: NavIntent[];
}

const MAX_DEPTH = 8;

function attentionView(record: Attention | undefined): AttentionView | undefined {
  if (record === undefined) return undefined;
  const detail = troubleDetail(record);
  const sinceMs = Date.parse(record.since);
  return {
    level: record.level,
    kind: record.kind,
    heuristic: record.heuristic,
    ...(Number.isNaN(sinceMs) ? {} : { sinceMs }),
    ...(detail === undefined ? {} : { detail: detail.text }),
  };
}

export function identityOf(agent: Agent): string {
  return identityKey({
    id: agent.id,
    kind: agent.kind,
    activity: "unknown",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
    ...(agent.displayName === undefined ? {} : { displayName: agent.displayName }),
    ...(agent.teamId === undefined ? {} : { teamId: agent.teamId }),
    ...(agent.sourceAgentId === undefined
      ? {}
      : { sourceId: agent.sourceId, sourceAgentId: agent.sourceAgentId }),
  });
}

/**
 * Views and intents for every agent that has not finished, in the store's order. Finished agents
 * are left out, so navigation walks them out. A subagent with a known parent gets an intent but no
 * view: the crew layer (`crew/subagents`) is its only drawing. `placementFor` must return the same object for an
 * id every time: navigation mutates it in place and the bots read it each frame.
 */
export function buildModels(
  input: ModelInput,
  table: ActivityAreaTable,
  placementFor: (id: string) => Placement,
): Models {
  const byId = new Map(input.agents.map((a) => [a.id, a]));
  const firstAttention = new Map<string, Attention>();
  for (const record of input.attention) {
    if (!firstAttention.has(record.agentId)) firstAttention.set(record.agentId, record);
  }
  const depthOf = (agent: Agent): number => {
    let depth = 0;
    let parentId = agent.parentAgentId;
    const seen = new Set([agent.id]);
    while (parentId !== undefined && !seen.has(parentId) && depth < MAX_DEPTH) {
      seen.add(parentId);
      depth++;
      parentId = byId.get(parentId)?.parentAgentId;
    }
    return depth;
  };

  const views: AgentView[] = [];
  const intents: NavIntent[] = [];
  for (const agent of input.agents) {
    if (agent.finishedAt !== undefined) continue;
    const activity = input.activity[agent.id]?.activity ?? "unknown";
    const record = firstAttention.get(agent.id);
    const attention = attentionView(record);
    const parent = agent.parentAgentId === undefined ? undefined : byId.get(agent.parentAgentId);
    const agentType = agent.kind === "subagent" ? agent.role : undefined;
    // A subagent whose parent is known is drawn by the crew layer (M5.02), so it has an intent
    // but no block-agent view. One without a recorded parent has no door to walk out of and
    // stays a block agent.
    if (agent.kind !== "subagent" || parent === undefined) {
      views.push({
        id: agent.id,
        kind: agent.kind,
        activity,
        depth: depthOf(agent),
        placement: placementFor(agent.id),
        ...(agent.displayName === undefined ? {} : { displayName: agent.displayName }),
        sourceId: agent.sourceId,
        ...(agent.sourceAgentId === undefined ? {} : { sourceAgentId: agent.sourceAgentId }),
        ...(agentType === undefined ? {} : { agentType }),
        ...(parent === undefined ? {} : { parentIdentity: identityOf(parent) }),
        ...(agent.teamId === undefined ? {} : { teamId: agent.teamId }),
        ...(attention === undefined ? {} : { attention }),
      });
    }
    const rest: RestState =
      record?.level === "waiting" || activity === "waiting"
        ? "waiting"
        : activity === "idle"
          ? "idle"
          : "working";
    const team =
      agent.teamId !== undefined &&
      input.teams !== undefined &&
      Object.hasOwn(input.teams, agent.teamId)
        ? input.teams[agent.teamId]
        : undefined;
    const area = areaFor(table, { activity, agentType, kind: agent.kind });
    intents.push({
      id: agent.id,
      area:
        agent.kind === "lead" && team !== undefined && team.endedAt === undefined
          ? "dispatch"
          : area,
      ...(agent.kind === "teammate" && agent.teamId !== undefined && area === null
        ? { initialArea: "dispatch" as const }
        : {}),
      hold: record?.level === "needs_you",
      rest,
      ...(agent.parentAgentId === undefined ? {} : { parentId: agent.parentAgentId }),
    });
  }
  return { views, intents };
}

/** Header counts: agents still in the city, and agents waiting on the user. */
export function agentCounts(agents: readonly Agent[], counts: AttentionCounts): AgentCounts {
  let active = 0;
  for (const a of agents) if (a.finishedAt === undefined) active++;
  return { active, needsYou: counts.needsYou };
}
