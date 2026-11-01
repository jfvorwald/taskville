import type { Agent } from "../../../data/domain.ts";

/** The recorded fields the family is built from (constitution IV: links are never guessed). */
export type FamilyAgent = Pick<Agent, "id" | "kind" | "parentAgentId" | "teamId" | "registeredSeq">;

/** Registered agents first, by registration order; the rest after them, by id. */
function bySeqThenId(a: FamilyAgent, b: FamilyAgent): number {
  const seqA = a.registeredSeq ?? Number.POSITIVE_INFINITY;
  const seqB = b.registeredSeq ?? Number.POSITIVE_INFINITY;
  if (seqA !== seqB) return seqA < seqB ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The recorded teams: a teammate's lead is the recorded one, when its team is recorded. */
export type FamilyTeams = Readonly<Record<string, { readonly leadAgentId: string }>>;

/**
 * Each agent's parent id. A subagent's parent is `parentAgentId`; a teammate's is the recorded
 * lead of its team, else the first registered lead agent with its `teamId`. An agent whose parent
 * is not known has no entry, so it is a root. A parent cycle (a self-parent included) is cut at
 * the member registered first, then lowest by id, which becomes the root: the result is a forest.
 */
function parentLinks(agents: readonly FamilyAgent[], teams?: FamilyTeams): Map<string, string> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const leads = new Map<string, FamilyAgent>();
  for (const a of [...agents].sort(bySeqThenId)) {
    if (a.kind === "lead" && a.teamId !== undefined && !leads.has(a.teamId)) leads.set(a.teamId, a);
  }
  const leadOf = (teamId: string): string | undefined =>
    teams !== undefined && Object.hasOwn(teams, teamId)
      ? teams[teamId]?.leadAgentId
      : leads.get(teamId)?.id;
  const parents = new Map<string, string>();
  for (const a of agents) {
    const parent =
      a.kind === "subagent"
        ? a.parentAgentId
        : a.kind === "teammate" && a.teamId !== undefined
          ? leadOf(a.teamId)
          : undefined;
    if (parent !== undefined && byId.has(parent)) parents.set(a.id, parent);
  }
  const settled = new Set<string>();
  for (const start of byId.keys()) {
    const trail: string[] = [];
    const onTrail = new Set<string>();
    let at: string | undefined = start;
    while (at !== undefined && !settled.has(at) && !onTrail.has(at)) {
      trail.push(at);
      onTrail.add(at);
      at = parents.get(at);
    }
    if (at !== undefined && onTrail.has(at)) {
      const members = trail.slice(trail.indexOf(at)).flatMap((id) => byId.get(id) ?? []);
      const [root] = members.sort(bySeqThenId);
      if (root !== undefined) parents.delete(root.id);
    }
    for (const id of trail) settled.add(id);
  }
  return parents;
}

/** Whether some agent records `agentId` as its parent. */
export function hasChildren(
  agentId: string,
  agents: readonly FamilyAgent[],
  teams?: FamilyTeams,
): boolean {
  for (const parent of parentLinks(agents, teams).values()) if (parent === agentId) return true;
  return false;
}

/** Ids from the root of the agent's family down to the agent; empty for an unknown agent. */
export function familyPath(
  agentId: string,
  agents: readonly FamilyAgent[],
  teams?: FamilyTeams,
): string[] {
  if (!agents.some((a) => a.id === agentId)) return [];
  const parents = parentLinks(agents, teams);
  const path = [agentId];
  for (let next = parents.get(agentId); next !== undefined; next = parents.get(next)) {
    path.push(next);
  }
  return path.reverse();
}

/** Every member of the agent's family, depth first, parent before children. */
export function familyOrder(
  agentId: string,
  agents: readonly FamilyAgent[],
  teams?: FamilyTeams,
): string[] {
  const [root] = familyPath(agentId, agents, teams);
  if (root === undefined) return [];
  const children = new Map<string, FamilyAgent[]>();
  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const [child, parent] of parentLinks(agents, teams)) {
    const entry = byId.get(child);
    if (entry !== undefined) children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  const order: string[] = [];
  const visit = (id: string) => {
    order.push(id);
    for (const child of (children.get(id) ?? []).sort(bySeqThenId)) visit(child.id);
  };
  visit(root);
  return order;
}

/** The next (`1`) or previous (`-1`) family member, wrapping; null when there is nowhere to go. */
export function stepFamily(
  agentId: string,
  agents: readonly FamilyAgent[],
  direction: 1 | -1,
  teams?: FamilyTeams,
): string | null {
  const order = familyOrder(agentId, agents, teams);
  const at = order.indexOf(agentId);
  if (at === -1 || order.length < 2) return null;
  return order[(at + direction + order.length) % order.length] ?? null;
}
