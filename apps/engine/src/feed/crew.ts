import { type Agent, type ProjectState, replay, type Team } from "@taskville/domain/reducer";
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
  summaries: ReadonlyMap<string, string>;
}

/**
 * Reads the stored projection when it matches the log (else replays the log, writing nothing) and,
 * in the same pass over the log, collects the finish summaries: the projection keeps only when an
 * agent finished, not what it reported.
 */
function loadCrewInput(storage: Storage, projectId: string): CrewInput {
  const summaries = new Map<string, string>();
  function* events() {
    for (const event of storage.events(projectId, 0)) {
      if (event.type === "agent.finished" && event.agentId !== undefined) {
        const summary = event.payload.summary;
        if (summary !== undefined && summary !== "") summaries.set(event.agentId, summary);
      }
      yield event;
    }
  }
  const stored = storage.projection<ProjectState>(projectId);
  if (
    stored !== undefined &&
    stored.reducerVersion === domainReducer.version &&
    stored.head === storage.head(projectId)
  ) {
    for (const _ of events()) {
      // Only the summaries are wanted from this pass.
    }
    return { state: stored.state, summaries };
  }
  return { state: replay(projectId, events()), summaries };
}

const byRegistration = (a: Agent, b: Agent): number =>
  (a.registeredSeq ?? 0) - (b.registeredSeq ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The crew of one agent: its subagents (recursively), and its team's teammates if it leads one. */
export function buildCrew(
  storage: Storage,
  projectId: string,
  agentId: string,
  now: Date,
): CrewResponse {
  const { state, summaries } = loadCrewInput(storage, projectId);
  const agents = Object.values(state.agents);
  const self = Object.hasOwn(state.agents, agentId) ? state.agents[agentId] : undefined;
  const teams = Object.values(state.teams);
  const team: Team | undefined =
    (self?.teamId !== undefined && Object.hasOwn(state.teams, self.teamId)
      ? state.teams[self.teamId]
      : undefined) ?? teams.find((t) => t.leadAgentId === agentId);

  const member = (
    agent: Agent,
    kind: CrewMember["kind"],
    teamOf: Team | undefined,
    seen: ReadonlySet<string>,
  ): CrewMember => {
    const finishedAt = agent.finishedAt ?? (kind === "teammate" ? teamOf?.endedAt : undefined);
    const activity = Object.hasOwn(state.activity, agent.id) ? state.activity[agent.id] : undefined;
    const summary = summaries.get(agent.id);
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
