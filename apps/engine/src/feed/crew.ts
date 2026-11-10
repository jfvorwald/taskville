import {
  type Agent,
  compareTimestamps,
  type ProjectState,
  replay,
  type Team,
} from "@taskville/domain/reducer";
import { domainReducer } from "../ingest/index.ts";
import type { Storage } from "../storage/index.ts";

/** One agent of a crew (contracts/http-api.md `GET /v1/agents/:id/crew`). */
export interface CrewMember {
  agentId: string;
  kind: "subagent" | "teammate";
  displayName?: string;
  /** Claude Code `agent_type` for a subagent; the role for a teammate. */
  agentType?: string;
  parentAgentId?: string;
  status: "running" | "finished";
  currentActivity?: { activity: string; since: string; heuristic: boolean };
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
  resultSummary?: string;
  /**
   * Whether the member's name, kind, or link rests on a heuristic. A member is listed only on a
   * recorded link, and recorded fields are never overwritten by a guess (constitution IV), so
   * this is false for every member; it stays in the shape so a client never has to infer it.
   */
  heuristic: boolean;
  children: CrewMember[];
}

export interface CrewResponse {
  agentId: string;
  projectId: string;
  team?: { id: string; name?: string; leadAgentId: string; startedAt: string; endedAt?: string };
  subagents: CrewMember[];
  teammates: CrewMember[];
}

/** A project's state and the summary each agent's `agent.finished` recorded. */
interface CrewInput {
  state: ProjectState;
  summaryOf: (agentId: string) => string | undefined;
}

/**
 * Reads the stored projection when it matches the log (else replays the log, writing nothing). A
 * finish summary is read from the agent index, one agent at a time: the projection keeps only when
 * an agent finished, not what it reported.
 */
function loadCrewInput(storage: Storage, projectId: string): CrewInput {
  const summaryOf = (agentId: string): string | undefined => {
    let summary: string | undefined;
    for (const event of storage.agentEventsOfType(projectId, agentId, "agent.finished")) {
      if (event.type !== "agent.finished") continue;
      const reported = event.payload.summary;
      if (reported !== undefined && reported !== "") summary = reported;
    }
    return summary;
  };
  const stored = storage.projection<ProjectState>(projectId);
  if (
    stored !== undefined &&
    stored.reducerVersion === domainReducer.version &&
    stored.head === storage.head(projectId)
  ) {
    return { state: stored.state, summaryOf };
  }
  return { state: replay(projectId, storage.events(projectId, 0)), summaryOf };
}

const byRegistration = (a: Agent, b: Agent): number =>
  (a.registeredSeq ?? 0) - (b.registeredSeq ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The team that started last (the later one in the record on a tie), or undefined for none. */
const latestStarted = (teams: readonly Team[]): Team | undefined =>
  teams.reduce<Team | undefined>(
    (best, t) =>
      best === undefined || compareTimestamps(t.startedAt, best.startedAt) >= 0 ? t : best,
    undefined,
  );

/** The crew of one agent: its subagents (recursively), and its team's teammates if it leads one. */
export function buildCrew(
  storage: Storage,
  projectId: string,
  agentId: string,
  now: Date,
): CrewResponse {
  const { state, summaryOf } = loadCrewInput(storage, projectId);
  const agents = Object.values(state.agents);
  const self = Object.hasOwn(state.agents, agentId) ? state.agents[agentId] : undefined;
  const teams = Object.values(state.teams);
  const memberOf: Team | undefined =
    self?.teamId !== undefined && Object.hasOwn(state.teams, self.teamId)
      ? state.teams[self.teamId]
      : undefined;
  // A lead that ran teams in sequence shows the one running (else the latest), not the first.
  const led = teams.filter((t) => t.leadAgentId === agentId);
  const running = led.filter((t) => t.endedAt === undefined);
  const team: Team | undefined =
    memberOf !== undefined && memberOf.leadAgentId !== agentId
      ? memberOf
      : (latestStarted(running.length > 0 ? running : led) ?? memberOf);

  const member = (
    agent: Agent,
    kind: CrewMember["kind"],
    teamOf: Team | undefined,
    seen: ReadonlySet<string>,
  ): CrewMember => {
    // A teammate is finished when it finished or its team ended, whichever came first.
    const teamEnd = kind === "teammate" ? teamOf?.endedAt : undefined;
    const finishedAt =
      agent.finishedAt !== undefined && teamEnd !== undefined
        ? compareTimestamps(teamEnd, agent.finishedAt) < 0
          ? teamEnd
          : agent.finishedAt
        : (agent.finishedAt ?? teamEnd);
    const activity = Object.hasOwn(state.activity, agent.id) ? state.activity[agent.id] : undefined;
    const summary = summaryOf(agent.id);
    const elapsed = Date.parse(finishedAt ?? now.toISOString()) - Date.parse(agent.firstSeenAt);
    const path = new Set(seen).add(agent.id);
    return {
      agentId: agent.id,
      kind,
      ...(agent.displayName === undefined ? {} : { displayName: agent.displayName }),
      ...(agent.role === undefined ? {} : { agentType: agent.role }),
      ...(agent.parentAgentId === undefined ? {} : { parentAgentId: agent.parentAgentId }),
      status: finishedAt === undefined ? "running" : "finished",
      ...(finishedAt === undefined && activity !== undefined && activity.activity !== "unknown"
        ? {
            currentActivity: {
              activity: activity.activity,
              since: activity.since,
              heuristic: activity.heuristic,
            },
          }
        : {}),
      startedAt: agent.firstSeenAt,
      ...(finishedAt === undefined ? {} : { finishedAt }),
      elapsedMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
      ...(summary === undefined ? {} : { resultSummary: summary }),
      heuristic: false,
      children: subagentsOf(agent.id, path),
    };
  };

  // A link is a recorded parent: a registration that names this agent. A cycle in bad data ends
  // at the first repeat.
  const subagentsOf = (parentId: string, seen: ReadonlySet<string>): CrewMember[] =>
    agents
      .filter(
        (a) =>
          a.registered && a.kind === "subagent" && a.parentAgentId === parentId && !seen.has(a.id),
      )
      .sort(byRegistration)
      .map((a) => member(a, "subagent", undefined, seen));

  const teammates =
    team !== undefined && team.leadAgentId === agentId
      ? team.memberAgentIds
          .flatMap((id) => (Object.hasOwn(state.agents, id) ? [state.agents[id] as Agent] : []))
          .filter((a) => a.registered && a.kind === "teammate")
          .map((a) => member(a, "teammate", team, new Set([agentId])))
      : [];

  return {
    agentId,
    projectId,
    ...(team === undefined
      ? {}
      : {
          team: {
            id: team.id,
            ...(team.name === undefined ? {} : { name: team.name }),
            leadAgentId: team.leadAgentId,
            startedAt: team.startedAt,
            ...(team.endedAt === undefined ? {} : { endedAt: team.endedAt }),
          },
        }),
    subagents: subagentsOf(agentId, new Set([agentId])),
    teammates,
  };
}
