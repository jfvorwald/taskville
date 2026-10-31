import type { StoredEnvelopeOf } from "@taskville/protocol";
import { getOwn, omit, optional, put } from "./maps.ts";
import { earlierTimestamp, laterTimestamp } from "./time.ts";
import type { Agent, DomainEvent, EntitiesState, Team } from "./types.ts";

// Agents and teams. Identity is `(sourceId, sourceAgentId)` and is never merged on name
// similarity; parent and team links come only from registrations, never from guesses (S-2).

/**
 * Records that an event named `agentId`: creates an unregistered placeholder (kind `unknown`)
 * if the agent is new, and widens its first and last seen times. Every event with an envelope
 * `agentId` passes through here, so later slices can rely on the agent and its activity
 * record existing.
 */
export function touchAgent(s: EntitiesState, e: DomainEvent, agentId: string): EntitiesState {
  const agent = getOwn(s.agents, agentId);
  if (agent === undefined) {
    const placeholder: Agent = {
      id: agentId,
      sourceId: e.sourceId,
      kind: "unknown",
      registered: false,
      connection: "unknown",
      firstSeenAt: e.occurredAt,
      lastSeenAt: e.occurredAt,
      toolCallCount: 0,
      consecutiveToolFailures: 0,
    };
    return {
      ...s,
      agents: put(s.agents, agentId, placeholder),
      activity: put(s.activity, agentId, {
        agentId,
        activity: "unknown",
        heuristic: false,
        since: e.occurredAt,
        openSessionCount: 0,
      }),
    };
  }
  const firstSeenAt = earlierTimestamp(agent.firstSeenAt, e.occurredAt);
  const lastSeenAt = laterTimestamp(agent.lastSeenAt, e.occurredAt);
  if (firstSeenAt === agent.firstSeenAt && lastSeenAt === agent.lastSeenAt) return s;
  return { ...s, agents: put(s.agents, agentId, { ...agent, firstSeenAt, lastSeenAt }) };
}

/** Applies `change` to an agent that exists (it always does after touchAgent). */
export function updateAgent(
  s: EntitiesState,
  agentId: string,
  change: (agent: Agent) => Agent,
): EntitiesState {
  const agent = getOwn(s.agents, agentId);
  if (agent === undefined) return s;
  const next = change(agent);
  return next === agent ? s : { ...s, agents: put(s.agents, agentId, next) };
}

export function applyRegistration(
  s: EntitiesState,
  e: StoredEnvelopeOf<"agent.registered">,
  agentId: string,
): EntitiesState {
  const p = e.payload;
  const before = getOwn(s.agents, agentId);
  if (
    before?.registered === true &&
    (before.sourceId !== e.sourceId || before.sourceAgentId !== p.sourceAgentId)
  ) {
    // A second identity claimed this agent ID. Identity never changes, so the claim is ignored.
    return s;
  }
  const touched = touchAgent(s, e, agentId);
  const agent = getOwn(touched.agents, agentId) as Agent;

  const mayHaveParent = p.kind === "subagent" || p.kind === "unknown";
  const mayHaveTeam = p.kind === "lead" || p.kind === "teammate" || p.kind === "unknown";
  // A registration that omits a link keeps the recorded one; a kind that forbids it drops it.
  const parentAgentId = mayHaveParent ? (p.parentAgentId ?? agent.parentAgentId) : undefined;
  const teamId = mayHaveTeam ? (p.teamId ?? agent.teamId) : undefined;

  const next: Agent = {
    ...omit(agent, ["parentAgentId", "teamId", "sourceValue"]),
    sourceId: e.sourceId,
    sourceAgentId: p.sourceAgentId,
    displayName: p.displayName,
    role: p.role,
    kind: p.kind,
    ...optional("sourceValue", p.kind === "unknown" ? p.sourceValue : undefined),
    ...optional("parentAgentId", parentAgentId),
    ...optional("teamId", teamId),
    registered: true,
    registeredSeq: agent.registeredSeq ?? e.ingestSequence,
  };
  const withAgent = { ...touched, agents: put(touched.agents, agentId, next) };
  return moveTeamMember(withAgent, agentId, agent.teamId, teamId);
}

function moveTeamMember(
  s: EntitiesState,
  agentId: string,
  from: string | undefined,
  to: string | undefined,
): EntitiesState {
  let teams = s.teams;
  if (from !== undefined && from !== to) {
    const team = getOwn(teams, from);
    if (team !== undefined) {
      teams = put(teams, from, {
        ...team,
        memberAgentIds: team.memberAgentIds.filter((id) => id !== agentId),
      });
    }
  }
  if (to !== undefined) {
    const team = getOwn(teams, to);
    if (team !== undefined && !team.memberAgentIds.includes(agentId)) {
      teams = put(teams, to, { ...team, memberAgentIds: [...team.memberAgentIds, agentId] });
    }
  }
  return teams === s.teams ? s : { ...s, teams };
}

export function applyTeamStarted(
  s: EntitiesState,
  e: StoredEnvelopeOf<"team.started">,
): EntitiesState {
  const { teamId, leadAgentId, name } = e.payload;
  const existing = getOwn(s.teams, teamId);
  if (existing !== undefined) {
    const team: Team = { ...existing, leadAgentId, ...optional("name", name) };
    return { ...s, teams: put(s.teams, teamId, team) };
  }
  // Agents may register with this team before team.started arrives (async hooks race).
  const memberAgentIds = Object.values(s.agents)
    .filter((agent) => agent.teamId === teamId)
    .sort(
      (a, b) =>
        (a.registeredSeq ?? 0) - (b.registeredSeq ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((agent) => agent.id);
  const team: Team = {
    id: teamId,
    leadAgentId,
    ...optional("name", name),
    memberAgentIds,
    startedAt: e.occurredAt,
  };
  return { ...s, teams: put(s.teams, teamId, team) };
}

export function applyTeamEnded(s: EntitiesState, e: StoredEnvelopeOf<"team.ended">): EntitiesState {
  const team = getOwn(s.teams, e.payload.teamId);
  if (team === undefined || team.endedAt !== undefined) return s;
  return { ...s, teams: put(s.teams, team.id, { ...team, endedAt: e.occurredAt }) };
}

/** Records the agent's latest turn event (session.turn_ended, turn_failed, idle_prompt). */
export const setLastTurn = (agent: Agent, lastTurn: Agent["lastTurn"], at: string): Agent =>
  lastTurn === undefined ? agent : { ...agent, lastTurn, lastTurnAt: at };

/**
 * Clears the latest turn per the attention rules (data-model.md): a prompt clears any turn; a
 * tool call starting or failing clears `ended` and `idle_prompt` but not `failed`; a succeeded
 * tool call clears all of them.
 */
export function clearLastTurn(agent: Agent, by: "prompt" | "tool" | "tool_succeeded"): Agent {
  if (agent.lastTurn === undefined) return agent;
  if (by === "tool" && agent.lastTurn === "failed") return agent;
  return omit(agent, ["lastTurn", "lastTurnAt"]);
}
