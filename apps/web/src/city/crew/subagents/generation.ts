import type { Agent } from "../../../data/domain.ts";
import { agentScale } from "../../agents/scale.ts";

/** Known ancestors up to the block agent that anchors the crew, or undefined for a cycle. */
export function crewLineage(agent: Agent, byId: ReadonlyMap<string, Agent>): string[] | undefined {
  const lineage: string[] = [];
  const seen = new Set([agent.id]);
  let current = agent;
  while (current.kind === "subagent" && current.parentAgentId !== undefined) {
    const parent = byId.get(current.parentAgentId);
    if (parent === undefined) break;
    if (seen.has(parent.id)) return undefined;
    seen.add(parent.id);
    lineage.push(parent.id);
    current = parent;
  }
  return lineage;
}

// How deep a family of subagents is drawn (ARCHITECTURE 2.9). Two generations get a bot each;
// everything below is shown as a count on the parent instead.

/** The deepest generation drawn as a bot. Generation 1 is a parent's own subagent. */
export const MAX_BOT_GENERATION = 2;

/** Size of a subagent bot. The same numbers the block agents use, so the crew and the city match. */
export function subagentScale(generation: number): number {
  return agentScale("subagent", Math.max(1, generation));
}

export interface Generational {
  readonly generation: number;
}

export interface GenerationSplit<T extends Generational> {
  readonly bots: T[];
  /** How many are too deep for a bot. */
  readonly deepCount: number;
}

/** Splits a family into those drawn as bots (in input order) and the count of those below. */
export function splitByGeneration<T extends Generational>(
  members: readonly T[],
): GenerationSplit<T> {
  const bots: T[] = [];
  let deepCount = 0;
  for (const m of members) {
    if (m.generation > MAX_BOT_GENERATION) deepCount++;
    else bots.push(m);
  }
  return { bots, deepCount };
}
