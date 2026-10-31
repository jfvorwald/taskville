// `taskville status` rendering (contracts/cli.md "status output"), pure over a snapshot.

import type { Agent, ProjectState } from "@taskville/domain/reducer";
import type { Attention, StoredReason } from "@taskville/protocol";

export interface StatusSnapshot {
  projectId: string;
  cursor: number;
  stateHash: string;
  state: ProjectState;
  attention: Attention[];
}

const LEVEL_RANK = { needs_you: 0, trouble: 1, waiting: 2 } as const;
const byName = (a: Agent, b: Agent) =>
  (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id, "en", { sensitivity: "base" }) ||
  a.id.localeCompare(b.id);

/** The agents shown: all, or all but finished subagents and everything beneath them. */
function visibleAgents(state: ProjectState, all: boolean): Agent[] {
  const agents = Object.values(state.agents);
  if (all) return agents;
  const hidden = new Set<string>();
  const hide = (id: string) => {
    if (hidden.has(id)) return;
    hidden.add(id);
    for (const child of agents) if (child.parentAgentId === id) hide(child.id);
  };
  for (const agent of agents) {
    if (agent.kind === "subagent" && agent.finishedAt !== undefined) hide(agent.id);
  }
  return agents.filter((a) => !hidden.has(a.id));
}

/** Children: a lead's teammates, then the agent's subagents, each ordered by display name. */
function treeOrder(state: ProjectState, agents: Agent[]): { agent: Agent; depth: number }[] {
  const present = new Set(agents.map((a) => a.id));
  const leadOf = (agent: Agent): string | undefined =>
    agent.kind === "teammate" && agent.teamId !== undefined
      ? state.teams[agent.teamId]?.leadAgentId
      : undefined;
  const parentOf = (agent: Agent): string | undefined => {
    if (agent.kind === "subagent") return agent.parentAgentId;
    if (agent.kind === "teammate") return leadOf(agent);
    return undefined;
  };
  const roots = agents
    .filter((a) => {
      const parent = parentOf(a);
      return parent === undefined || !present.has(parent) || parent === a.id;
    })
    .sort(byName);
  const out: { agent: Agent; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (agent: Agent, depth: number) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    out.push({ agent, depth });
    const teammates = agents
      .filter((a) => a.kind === "teammate" && leadOf(a) === agent.id)
      .sort(byName);
    const subagents = agents
      .filter((a) => a.kind === "subagent" && a.parentAgentId === agent.id)
      .sort(byName);
    for (const child of [...teammates, ...subagents])
      if (child.id !== agent.id) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // Anything left is in a parent cycle; list it at the top level rather than lose it.
  for (const agent of agents.filter((a) => !seen.has(a.id)).sort(byName)) visit(agent, 0);
  return out;
}

export function reasonText(reason: StoredReason | undefined): string {
  if (reason === undefined) return "";
  const markers = [reason.masked ? " [masked]" : "", reason.truncated ? " [truncated]" : ""].join(
    "",
  );
  return `${reason.text}${markers}`;
}

function attentionText(record: Attention, state: ProjectState): string {
  const reason = reasonText(record.reason);
  if (record.level === "waiting") return "waiting";
  if (record.level === "needs_you") {
    const request = record.requestId === undefined ? undefined : state.requests[record.requestId];
    const what = [record.kind, request?.toolName].filter(Boolean).join(" ");
    return `needs you: ${what}${reason === "" ? "" : ` - ${reason}`}`;
  }
  if (record.heuristic) return `trouble (heuristic): ${reason === "" ? record.kind : reason}`;
  return `trouble: ${record.kind}${reason === "" ? "" : ` - ${reason}`}`;
}

function highest(records: Attention[], agentId: string): Attention | undefined {
  return records
    .filter((r) => r.agentId === agentId)
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.since.localeCompare(b.since))[0];
}

function line(agent: Agent, state: ProjectState, attention: Attention[]): string {
  const activity = state.activity[agent.id];
  const parts = [
    `${agent.displayName ?? agent.id}${agent.kind === "session" ? "" : ` (${agent.kind})`}`,
    agent.connection,
    `${activity?.activity ?? "idle"}${activity?.heuristic ? " (heuristic)" : ""}`,
  ];
  if (activity?.taskId !== undefined)
    parts.push(state.tasks[activity.taskId]?.title ?? activity.taskId);
  if (agent.finishedAt !== undefined) parts.push("finished");
  const record = highest(attention, agent.id);
  if (record !== undefined) parts.push(attentionText(record, state));
  return parts.join(" · ");
}

export function renderStatus(
  snapshot: StatusSnapshot,
  options: { projectName: string; all: boolean },
): string {
  const { state, attention } = snapshot;
  const agentsAll = Object.values(state.agents);
  const active = agentsAll.filter((a) => {
    if (a.finishedAt !== undefined) return false;
    // cli.md says "neither idle nor waiting"; unknown is left out too, so an agent that has not
    // reported an activity is not presented as active (constitution IV, quickstart's 1 active).
    const name = state.activity[a.id]?.activity ?? "idle";
    return name !== "idle" && name !== "waiting" && name !== "unknown";
  }).length;
  const count = (level: Attention["level"]) =>
    new Set(attention.filter((r) => r.level === level).map((r) => r.agentId)).size;
  const header = `${options.projectName} · ${active} active · ${count("needs_you")} needs you · ${count("trouble")} trouble · ${count("waiting")} waiting`;
  const rows = treeOrder(state, visibleAgents(state, options.all)).map(
    ({ agent, depth }) => `${"  ".repeat(depth)}${line(agent, state, attention)}`,
  );
  return `${[header, ...(rows.length === 0 ? ["(no agents)"] : rows)].join("\n")}\n`;
}

export function statusJson(snapshot: StatusSnapshot, options: { all: boolean }) {
  const agents = visibleAgents(snapshot.state, options.all).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const shown = new Set(agents.map((a) => a.id));
  return {
    projectId: snapshot.projectId,
    cursor: snapshot.cursor,
    stateHash: snapshot.stateHash,
    agents,
    attention: snapshot.attention.filter((r) => shown.has(r.agentId)),
  };
}
