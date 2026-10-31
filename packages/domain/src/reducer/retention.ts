import type { PendingRequest, RequestsState } from "./attention/index.ts";
import { type IdMap, put, removeKeys } from "./entities/maps.ts";
import { compareTimestamps } from "./entities/time.ts";
import type { Agent, EntitiesState, Task } from "./entities/types.ts";

// Retention (data-model.md "Retention", M2.16, decision #202 D1 default). The last step of
// `reduce`: closed and finished records stay in the projection only while they are among the
// newest, so state is bounded however long a project runs. The event log keeps everything.
// Reads only state, never a clock, so replay and a resumed checkpoint agree.

/** Finished agents kept per project. */
export const RETAIN_FINISHED_AGENTS = 50;
/** Terminal tasks (`completed`, `failed`, `cancelled`) kept per project. */
export const RETAIN_TERMINAL_TASKS = 50;
/** Closed requests (state not `open`) kept per project. */
export const RETAIN_CLOSED_REQUESTS = 50;

/** How many records retention dropped; kept records plus these are the totals. */
export interface Retired {
  readonly agents: number;
  readonly tasks: number;
  readonly requests: number;
}

export const initialRetired = (): Retired => ({ agents: 0, tasks: 0, requests: 0 });

type RetainedState = EntitiesState & RequestsState & { readonly retired: Retired };

const TERMINAL_TASKS: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The records beyond the newest `keep`, newest first by `at`, then by ID. */
function beyondNewest<T extends { id: string }>(
  records: T[],
  at: (record: T) => string,
  keep: number,
): T[] {
  if (records.length <= keep) return [];
  return records.sort((a, b) => compareTimestamps(at(b), at(a)) || order(a.id, b.id)).slice(keep);
}

export function retain<S extends RetainedState>(state: S): S {
  return retainRequests(retainTasks(retainAgents(state)));
}

function retainAgents<S extends RetainedState>(s: S): S {
  const finished = Object.values(s.agents).filter((a) => a.finishedAt !== undefined);
  const beyond = beyondNewest(
    finished,
    (a: Agent) => a.finishedAt as string,
    RETAIN_FINISHED_AGENTS,
  );
  if (beyond.length === 0) return s;

  // Never dropped: a parent of an unfinished agent, the lead of a team that has not ended, an
  // agent with an open request, or one with a running tool call.
  const kept = new Set<string>();
  for (const agent of Object.values(s.agents)) {
    if (agent.finishedAt === undefined && agent.parentAgentId !== undefined) {
      kept.add(agent.parentAgentId);
    }
  }
  for (const team of Object.values(s.teams))
    if (team.endedAt === undefined) kept.add(team.leadAgentId);
  for (const request of Object.values(s.requests))
    if (request.state === "open") kept.add(request.agentId);
  for (const call of Object.values(s.toolCalls))
    if (call.phase === "running") kept.add(call.agentId);

  const drop = new Set(beyond.filter((a) => !kept.has(a.id)).map((a) => a.id));
  if (drop.size === 0) return s;

  const ownedBy = <T extends { id: string; agentId: string }>(map: IdMap<T>) =>
    new Set(
      Object.values(map)
        .filter((r) => drop.has(r.agentId))
        .map((r) => r.id),
    );
  let teams = s.teams;
  for (const team of Object.values(s.teams)) {
    if (team.memberAgentIds.some((id) => drop.has(id))) {
      const memberAgentIds = team.memberAgentIds.filter((id) => !drop.has(id));
      teams = put(teams, team.id, { ...team, memberAgentIds });
    }
  }
  return {
    ...s,
    agents: removeKeys(s.agents, drop),
    activity: removeKeys(s.activity, drop),
    toolCalls: removeKeys(s.toolCalls, ownedBy(s.toolCalls)),
    sessions: removeKeys(s.sessions, ownedBy(s.sessions)),
    teams,
    retired: { ...s.retired, agents: s.retired.agents + drop.size },
  };
}

function retainTasks<S extends RetainedState>(s: S): S {
  const terminal = Object.values(s.tasks).filter((t) => TERMINAL_TASKS.has(t.status));
  const beyond = beyondNewest(terminal, (t: Task) => t.updatedAt, RETAIN_TERMINAL_TASKS);
  if (beyond.length === 0) return s;
  const drop = new Set(beyond.map((t) => t.id));
  return {
    ...s,
    tasks: removeKeys(s.tasks, drop),
    retired: { ...s.retired, tasks: s.retired.tasks + drop.size },
  };
}

function retainRequests<S extends RetainedState>(s: S): S {
  const closed = Object.values(s.requests).filter((r) => r.state !== "open");
  const beyond = beyondNewest(closed, (r: PendingRequest) => r.openedAt, RETAIN_CLOSED_REQUESTS);
  if (beyond.length === 0) return s;
  const drop = new Set(beyond.map((r) => r.id));
  return {
    ...s,
    requests: removeKeys(s.requests, drop) as Record<string, PendingRequest>,
    retired: { ...s.retired, requests: s.retired.requests + drop.size },
  };
}
