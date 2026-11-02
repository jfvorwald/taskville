import type { Attention } from "../../../data/domain.ts";

// M5.10 stuck attribution for subagents and teammates (ARCHITECTURE 2.9, decision #120).
//
// RED STUB: the types below are the contract the tests pin; `crewAttribution` returns the empty
// attribution so the tests fail on their assertions. The implementer replaces the body only.

/** The slice of the domain `Agent` the attribution reads; the reducer's `Agent` satisfies it. */
export interface AttributionAgent {
  readonly id: string;
  readonly kind: string;
  readonly displayName?: string;
  /** `subagent` only: the spawning agent, once a recorded link exists. */
  readonly parentAgentId?: string;
  readonly teamId?: string;
}

export interface CrewAttributionInput {
  readonly agents: Readonly<Record<string, AttributionAgent>>;
  readonly teams: Readonly<Record<string, { readonly leadAgentId: string }>>;
  /** The domain's attention records (`attention(state, now)`); only `needs_you` counts here. */
  readonly attention: readonly Attention[];
}

/** "for: pip" on a lead whose red state belongs to a teammate that is not identified (#120 D2). */
export interface ForLabel {
  /** The text the card shows, for example "for: pip". */
  readonly text: string;
  /** Always true: the name comes from notification text, so the label says it is a guess. */
  readonly heuristic: true;
}

export interface CrewAttribution {
  /** Agent ids that wear the red state: one with an open `needs_you` record. Sorted. */
  readonly red: readonly string[];
  /** Wearer id -> the red agents below it (subagent ancestors, team lead). Sorted, no empties. */
  readonly dots: Readonly<Record<string, readonly string[]>>;
  /** Lead id -> the "for: <teammate>" label, only for heuristic (indirect) records. */
  readonly forLabels: Readonly<Record<string, ForLabel>>;
}

export function crewAttribution(_input: CrewAttributionInput): CrewAttribution {
  return { red: [], dots: {}, forLabels: {} };
}
