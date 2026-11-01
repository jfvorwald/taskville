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

/**
 * Each agent's parent id. A subagent's parent is `parentAgentId`; a teammate's is the lead of its
 * team. An agent whose parent is not known has no entry, so it is a root.
 */
function parentLinks(agents: readonly FamilyAgent[]): Map<string, string> {
  const known = new Set(agents.map((a) => a.id));
  const leads = new Map<string, FamilyAgent>();
  for (const a of [...agents].sort(bySeqThenId)) {
    if (a.kind === "lead" && a.teamId !== undefined && !leads.has(a.teamId)) leads.set(a.teamId, a);
  }
  const parents = new Map<string, string>();
  for (const a of agents) {
    const parent =
      a.kind === "subagent"
        ? a.parentAgentId
        : a.kind === "teammate" && a.teamId !== undefined
          ? leads.get(a.teamId)?.id
          : undefined;
    if (parent !== undefined && known.has(parent)) parents.set(a.id, parent);
  }
  return parents;
}

/** Whether some agent records `agentId` as its parent. */
export function hasChildren(agentId: string, agents: readonly FamilyAgent[]): boolean {
  for (const parent of parentLinks(agents).values()) if (parent === agentId) return true;
  return false;
}

/** Ids from the root of the agent's family down to the agent; empty for an unknown agent. */
export function familyPath(agentId: string, agents: readonly FamilyAgent[]): string[] {
  if (!agents.some((a) => a.id === agentId)) return [];
  const parents = parentLinks(agents);
  const path = [agentId];
  const seen = new Set(path);
  for (let next = parents.get(agentId); next !== undefined && !seen.has(next); ) {
    path.push(next);
    seen.add(next);
    next = parents.get(next);
  }
  return path.reverse();
}

/** Every member of the agent's family, depth first, parent before children. */
export function familyOrder(agentId: string, agents: readonly FamilyAgent[]): string[] {
  const [root] = familyPath(agentId, agents);
  if (root === undefined) return [];
  const children = new Map<string, FamilyAgent[]>();
  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const [child, parent] of parentLinks(agents)) {
    const entry = byId.get(child);
    if (entry !== undefined) children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
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
): string | null {
  const order = familyOrder(agentId, agents);
  const at = order.indexOf(agentId);
  if (at === -1 || order.length < 2) return null;
  return order[(at + direction + order.length) % order.length] ?? null;
}
