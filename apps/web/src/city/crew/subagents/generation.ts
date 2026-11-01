import { agentScale } from "../../agents/scale.ts";

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
