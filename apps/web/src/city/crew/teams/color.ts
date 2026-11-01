import { agentColors } from "../../agents/identity.ts";

/** Use the block-agent palette so decorations and the shared scarf always agree. */
export function teamScarfColor(teamId: string, _theme?: string): string {
  return agentColors({
    id: teamId,
    kind: "teammate",
    teamId,
    activity: "unknown",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
  }).trim;
}
