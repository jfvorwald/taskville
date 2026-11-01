import type { Agent, ProjectState } from "../../../data/domain.ts";

/**
 * Time since the agent was first seen, up to `nowMs` while it runs and up to `finishedAt` once it
 * has finished. Null when a timestamp is not a date.
 */
export function elapsedMs(
  agent: Pick<Agent, "firstSeenAt" | "finishedAt">,
  nowMs: number,
): number | null {
  const start = Date.parse(agent.firstSeenAt);
  const end = agent.finishedAt === undefined ? nowMs : Date.parse(agent.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** `45s`, `2m 5s`, `1h 2m`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** The first file of the agent's newest running tool call; null when it names none. */
export function currentFile(agentId: string, toolCalls: ProjectState["toolCalls"]): string | null {
  let newest: ProjectState["toolCalls"][string] | undefined;
  for (const call of Object.values(toolCalls)) {
    if (call.agentId !== agentId || call.phase !== "running") continue;
    if (newest === undefined || call.startSeq > newest.startSeq) newest = call;
  }
  return newest?.filePaths[0] ?? null;
}
