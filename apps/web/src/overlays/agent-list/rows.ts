import type { MovementLabel } from "../../city/movement/labels.ts";

export interface AgentListRow {
  readonly id: string;
  readonly name: string;
  /**
   * What a screen reader hears: `Name, Status`, plus `, on the way` while it walks. A subagent
   * adds its kind: `Name, subagent, Status`.
   */
  readonly description: string;
  /** The description without the name: `Status` and `, on the way` while it walks. */
  readonly detail: string;
  readonly urgent: boolean;
  /** `subagent` for a subagent the crew layer draws; absent for every other agent. */
  readonly kind?: "subagent";
}

/** The scene's label rows as list rows: agents that need you first, then by name. */
export function agentListRows(labels: readonly MovementLabel[]): AgentListRow[] {
  return labels
    .map((l) => {
      const detail = l.onTheWay ? `${l.status}, on the way` : l.status;
      return {
        id: l.id,
        name: l.name,
        description:
          l.kind === undefined ? `${l.name}, ${detail}` : `${l.name}, ${l.kind}, ${detail}`,
        detail,
        urgent: l.urgent,
        ...(l.kind === undefined ? {} : { kind: l.kind }),
      };
    })
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.name.localeCompare(b.name));
}
