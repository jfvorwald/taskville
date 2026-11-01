import type { AgentView } from "../../agents/types.ts";
import { teamScarfColor } from "./color.ts";

export function teamAccessories(agents: readonly AgentView[]) {
  const seen = new Set<string>();
  return agents.flatMap((agent) => {
    if (
      agent.teamId === undefined ||
      (agent.kind !== "lead" && agent.kind !== "teammate") ||
      seen.has(agent.id)
    )
      return [];
    seen.add(agent.id);
    return [
      {
        agentId: agent.id,
        scarf: teamScarfColor(agent.teamId),
        hardHat: agent.kind === "lead",
        ...(agent.kind === "lead" ? { home: "dispatch" as const } : {}),
        ...(agent.displayName === undefined ? {} : { nameTag: agent.displayName }),
      },
    ];
  });
}
