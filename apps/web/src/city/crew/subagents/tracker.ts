import type { Agent } from "../../../data/domain.ts";
import { identityKey } from "../../agents/identity.ts";
import type { AgentView } from "../../agents/types.ts";
import { MAX_BOT_GENERATION, splitByGeneration } from "./generation.ts";
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

const MAX_HOPS = 8;

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
    ...(parent === undefined ? {} : { parentIdentity: identityOfParent(parent) }),
  };
}

/** The same identity text the city's bots use for their trim, so a family shares one color. */
function identityOfParent(agent: Agent): string {
  return identityKey({
    id: agent.id,
    kind: agent.kind,
    activity: "unknown",
    placement: NO_POSITION,
    ...(agent.displayName === undefined ? {} : { displayName: agent.displayName }),
    ...(agent.teamId === undefined ? {} : { teamId: agent.teamId }),
    ...(agent.sourceAgentId === undefined
      ? {}
      : { sourceId: agent.sourceId, sourceAgentId: agent.sourceAgentId }),
  });
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
        const finished = agent.finishedAt !== undefined;
        let state = states.get(agent.id);
        if (state === undefined) {
          // Never seen running: nothing to walk out or back.
          if (finished) continue;
          state = observeSubagent(initialLifecycle(), { kind: "started", atMs: nowMs });
        }
        if (finished) state = observeSubagent(state, { kind: "finished", atMs: nowMs });
        states.set(agent.id, state);
        present.add(agent.id);

        const lineage = [agent.parentAgentId];
        const seen = new Set([agent.id]);
        for (let hops = 0; hops < MAX_HOPS; hops++) {
          const up = byId.get(lineage[lineage.length - 1] as string);
          if (up?.kind !== "subagent" || up.parentAgentId === undefined || seen.has(up.id)) break;
          seen.add(up.id);
          lineage.push(up.parentAgentId);
        }
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
        { members: CrewMember[]; deepCount: number; parentGeneration: number }
      >();
      const familyOf = (parentId: string, parentGeneration: number) => {
        let family = families.get(parentId);
        if (family === undefined) {
          family = { members: [], deepCount: 0, parentGeneration };
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
