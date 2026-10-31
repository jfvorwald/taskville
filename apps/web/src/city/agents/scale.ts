import type { AgentKindView } from "./types.ts";

const SUBAGENT_STEP = 0.6;
const MIN_SCALE = 0.3;

/** Size of a bot. Sessions, leads and teammates are full size; each subagent generation is smaller. */
export function agentScale(kind: AgentKindView, depth: number): number {
  if (kind !== "subagent") return 1;
  return Math.max(MIN_SCALE, SUBAGENT_STEP ** Math.max(1, depth));
}
