import type { Attention } from "../../../data/domain.ts";

// M5.10 stuck attribution for subagents and teammates (ARCHITECTURE 2.9, decision #120).

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

/** "for: pip (Bash)" is the adapter's reason text; the card shows only "for: pip". */
const FOR_REASON = /^(for: .+?)(?: \([^()]*\))?$/;
const FALLBACK_LABEL = "for: a teammate";

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `input.attention` must be in `attention()` order (the domain's order, the one the action card
 * uses): the lead's "for:" label depends on which needs-you record comes first.
 */
export function crewAttribution(input: CrewAttributionInput): CrewAttribution {
  const red = new Set<string>();
  const dots = new Map<string, Set<string>>();
  const forLabels: Record<string, ForLabel> = {};
  const firstSeen = new Set<string>(); // leads whose first needs-you record has been seen

  const dot = (wearerId: string, redId: string): void => {
    if (wearerId === redId) return;
    const set = dots.get(wearerId) ?? new Set<string>();
    set.add(redId);
    dots.set(wearerId, set);
  };

  for (const record of input.attention) {
    if (record.level !== "needs_you") continue;
    const agent = input.agents[record.agentId];
    if (agent === undefined) continue; // nothing is guessed about an agent we do not know
    red.add(agent.id);

    if (agent.kind === "lead" && !firstSeen.has(agent.id)) {
      firstSeen.add(agent.id);
      // The label follows the lead's first needs-you record of any kind, the one the action card
      // opens, and shows only when that record is heuristic.
      if (record.heuristic === true) {
        const match = FOR_REASON.exec(record.reason?.text ?? "");
        forLabels[agent.id] = { text: match?.[1] ?? FALLBACK_LABEL, heuristic: true };
      }
    }

    // Walk the recorded links only: parentAgentId, then the team lead. The seen set stops a cycle.
    const seen = new Set<string>();
    let node: AttributionAgent | undefined = agent;
    while (node !== undefined && !seen.has(node.id)) {
      seen.add(node.id);
      const leadId = node.teamId === undefined ? undefined : input.teams[node.teamId]?.leadAgentId;
      if (leadId !== undefined && input.agents[leadId] !== undefined) dot(leadId, agent.id);
      node = node.parentAgentId === undefined ? undefined : input.agents[node.parentAgentId];
      if (node !== undefined) dot(node.id, agent.id);
    }
  }

  const sortedDots: Record<string, readonly string[]> = {};
  for (const [wearer, ids] of dots) sortedDots[wearer] = [...ids].sort(byText);
  return { red: [...red].sort(byText), dots: sortedDots, forLabels };
}

/**
 * The red ids the lead's own dot stands for (roborev 6596). Keeps every red id that reaches the
 * lead through a teammate (the teammate itself, or its subagents at any depth); drops red agents
 * that sit directly under the lead, because SubagentCrew already dots those.
 */
export function leadDotTargets(
  out: CrewAttribution,
  agents: Readonly<Record<string, AttributionAgent>>,
  leadId: string,
): readonly string[] {
  const viaTeammate = (id: string): boolean => {
    const seen = new Set<string>();
    for (
      let node: AttributionAgent | undefined = agents[id];
      node !== undefined && !seen.has(node.id);
      node = node.parentAgentId === undefined ? undefined : agents[node.parentAgentId]
    ) {
      if (node.kind === "teammate") return true;
      seen.add(node.id);
    }
    return false;
  };
  return (out.dots[leadId] ?? []).filter(viaTeammate);
}
