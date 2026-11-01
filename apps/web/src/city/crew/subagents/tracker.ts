import type { Agent } from "../../../data/domain.ts";
import type { AgentView } from "../../agents/types.ts";
import { identityOf } from "../../movement/models.ts";
import { crewLineage, MAX_BOT_GENERATION, splitByGeneration } from "./generation.ts";
import {
  initialLifecycle,
  type LifecycleState,
  observeSubagent,
  type SubagentFrame,
  subagentFrame,
} from "./lifecycle.ts";

// Turns the store's agents into the families the crew layer draws, and remembers when each
// subagent was first seen running and first seen finished (the lifecycle clock). A subagent that
// is already finished the first time it is seen never walks: history is not replayed as a parade.

export interface CrewMember {
  readonly id: string;
  /** 1 for a subagent of the family's parent, 2 for its subagent, and so on. */
  readonly generation: number;
  /** What `agentColors` reads: body color by type, trim color by the parent. */
  readonly view: AgentView;
}

export interface CrewFamily {
  /** The agent the bots walk out of: their immediate parent. */
  readonly parentId: string;
  /** 0 when the parent is not a subagent, otherwise the parent's own generation. */
  readonly parentGeneration: number;
  /** Bots in registration order, including those still leaving after they finished. */
  readonly members: readonly CrewMember[];
  /** Running subagents below this parent's bots that are too deep for a bot of their own. */
  readonly deepCount: number;
  readonly deepIds: readonly string[];
}

export interface CrewTracker {
  /** Observes starts and finishes at `nowMs` and returns the families to draw. */
  sync(agents: readonly Agent[], nowMs: number): CrewFamily[];
  /** The tracked subagent's frame, or undefined when it is not tracked. */
  frame(id: string, nowMs: number): SubagentFrame | undefined;
}

const NO_POSITION = { x: 0, y: 0, z: 0, heading: 0 };

function viewOf(agent: Agent, parent: Agent | undefined): AgentView {
  return {
    id: agent.id,
    kind: "subagent",
    activity: "unknown",
    placement: NO_POSITION,
    sourceId: agent.sourceId,
    ...(agent.sourceAgentId === undefined ? {} : { sourceAgentId: agent.sourceAgentId }),
    ...(agent.displayName === undefined ? {} : { displayName: agent.displayName }),
    ...(agent.role === undefined ? {} : { agentType: agent.role }),
    ...(parent === undefined ? {} : { parentIdentity: identityOf(parent) }),
  };
}

interface Tracked {
  readonly member: CrewMember;
  readonly generation: number;
  /** Ancestors from the parent up to the first one that is not a subagent. */
  readonly lineage: readonly string[];
  readonly finished: boolean;
}

export function createCrewTracker(): CrewTracker {
  const states = new Map<string, LifecycleState>();

  return {
    sync(agents, nowMs) {
      const byId = new Map(agents.map((a) => [a.id, a]));
      const present = new Set<string>();
      const tracked: Tracked[] = [];

      for (const agent of agents) {
        if (agent.kind !== "subagent" || agent.parentAgentId === undefined) continue;
        // A parent that is not in the store leaves nothing to walk out of: the subagent stays a
        // block agent (`buildModels`), so it is not drawn a second time here.
        if (!byId.has(agent.parentAgentId)) continue;
        const lineage = crewLineage(agent, byId);
        if (lineage === undefined) continue;
        const finished = agent.finishedAt !== undefined;
        let state = states.get(agent.id);
        if (state === undefined) {
          // Never seen running: nothing to walk out or back.
          if (finished) continue;
          state = observeSubagent(initialLifecycle(), { kind: "started", atMs: nowMs });
        }
        if (finished) state = observeSubagent(state, { kind: "finished", atMs: nowMs });
        // Done and faded: dropped, so history never costs a frame. Once dropped, a finished agent
        // is skipped above as one that was never seen running.
        if (subagentFrame(state, nowMs).phase === "gone") continue;
        states.set(agent.id, state);
        present.add(agent.id);

        const generation = lineage.length;
        tracked.push({
          member: {
            id: agent.id,
            generation,
            view: viewOf(agent, byId.get(agent.parentAgentId)),
          },
          generation,
          lineage,
          finished,
        });
      }

      for (const id of [...states.keys()]) if (!present.has(id)) states.delete(id);

      // A family is the bots of one immediate parent. Running subagents below the last bot level
      // are counted on their generation-2 ancestor, the deepest parent that is drawn.
      const families = new Map<
        string,
        { members: CrewMember[]; deepCount: number; deepIds: string[]; parentGeneration: number }
      >();
      const familyOf = (parentId: string, parentGeneration: number) => {
        let family = families.get(parentId);
        if (family === undefined) {
          family = { members: [], deepCount: 0, deepIds: [], parentGeneration };
          families.set(parentId, family);
        }
        return family;
      };
      const { bots, deepCount } = splitByGeneration(tracked);
      for (const t of bots) {
        familyOf(t.lineage[0] as string, t.generation - 1).members.push(t.member);
      }
      if (deepCount > 0) {
        for (const t of tracked) {
          if (t.generation <= MAX_BOT_GENERATION || t.finished) continue;
          const owner = t.lineage[t.generation - MAX_BOT_GENERATION - 1] as string;
          familyOf(owner, MAX_BOT_GENERATION).deepCount++;
          familyOf(owner, MAX_BOT_GENERATION).deepIds.push(t.member.id);
        }
      }
      // Parents first: a family anchored on a bot reads that bot's place from the family above.
      return [...families]
        .map(([parentId, f]) => ({ parentId, ...f }))
        .sort((x, y) => x.parentGeneration - y.parentGeneration);
    },

    frame(id, nowMs) {
      const state = states.get(id);
      return state === undefined ? undefined : subagentFrame(state, nowMs);
    },
  };
}
