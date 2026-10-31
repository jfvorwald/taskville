import {
  applyRegistration,
  applyTeamEnded,
  applyTeamStarted,
  clearLastTurn,
  setLastTurn,
  touchAgent,
  updateAgent,
} from "./agents.ts";
import {
  applySessionEnded,
  applySessionSeen,
  applySessionStarted,
  refreshActivity,
  setActivity,
  setLatestEvidence,
} from "./sessions.ts";
import {
  applyTaskAssigned,
  applyTaskCreated,
  applyTaskHandoff,
  applyTaskStatusChanged,
} from "./tasks.ts";
import { applyToolCallFinished, applyToolCallStarted } from "./tool-calls.ts";
import type { DomainEvent, EntitiesState } from "./types.ts";

export { compareTimestamps, laterTimestamp } from "./time.ts";
export { MAX_OPEN_TOOL_CALLS_PER_AGENT } from "./tool-calls.ts";
export type * from "./types.ts";

// The entities slice: agents, teams, sessions, tasks, activity, and tool calls (ARCHITECTURE.md
// section 6, data-model.md). Pure: time comes only from `occurredAt`, and nothing reads a clock,
// randomness, or I/O. Request, command, and attention events are another slice's (M1.08); here
// they only mark their agent as seen.

export const initialEntities = (): EntitiesState => ({
  agents: {},
  teams: {},
  sessions: {},
  toolCalls: {},
  tasks: {},
  activity: {},
});

/** Applies one event to the entity keys of `state`, leaving every other key as it was. */
export function reduceEntities<S extends EntitiesState>(state: S, event: DomainEvent): S {
  const before: EntitiesState = {
    agents: state.agents,
    teams: state.teams,
    sessions: state.sessions,
    toolCalls: state.toolCalls,
    tasks: state.tasks,
    activity: state.activity,
  };
  const after = applyEvent(before, event);
  return after === before ? state : { ...state, ...after };
}

function applyEvent(s0: EntitiesState, e: DomainEvent): EntitiesState {
  const agentId = e.agentId;
  // Registration decides for itself whether the event counts (an identity conflict does not).
  let s = agentId === undefined || e.type === "agent.registered" ? s0 : touchAgent(s0, e, agentId);

  switch (e.type) {
    case "agent.registered":
      if (agentId === undefined) return s;
      return refreshActivity(applyRegistration(s, e, agentId), e, agentId);
    case "agent.connected":
    case "agent.disconnected": {
      if (agentId === undefined) return s;
      const connection = e.type === "agent.connected" ? "connected" : "disconnected";
      return updateAgent(s, agentId, (a) =>
        a.connection === connection ? a : { ...a, connection },
      );
    }
    case "agent.finished":
      if (agentId === undefined) return s;
      return updateAgent(s, agentId, (a) => ({ ...a, finishedAt: e.occurredAt }));
    case "team.started":
      return applyTeamStarted(s, e);
    case "team.ended":
      return applyTeamEnded(s, e);
    case "session.started":
    case "session.ended":
    case "session.prompt_submitted":
    case "session.turn_ended":
    case "session.turn_failed":
    case "session.idle_prompt": {
      const sessionId = e.sessionId;
      if (agentId === undefined || sessionId === undefined) return s;
      if (e.type === "session.started") s = applySessionStarted(s, e, agentId, sessionId);
      else if (e.type === "session.ended") s = applySessionEnded(s, e, agentId, sessionId);
      else s = applySessionSeen(s, e, agentId, sessionId);
      s = updateAgent(s, agentId, (a) => turnEffect(a, e.type, e.occurredAt));
      return refreshActivity(s, e, agentId);
    }
    case "task.created":
    case "task.assigned":
    case "task.status_changed":
    case "task.handoff": {
      const taskId = e.taskId;
      if (taskId === undefined) return s;
      if (e.type === "task.created") return applyTaskCreated(s, e, taskId);
      if (e.type === "task.assigned") return applyTaskAssigned(s, e, taskId);
      if (e.type === "task.status_changed") return applyTaskStatusChanged(s, e, taskId);
      s = applyTaskHandoff(s, e, taskId);
      const from = e.payload.fromAgentId;
      if (!Object.hasOwn(s.agents, from)) return s;
      s = setActivity(s, e, from, {
        activity: "handing_off",
        heuristic: false,
        since: e.occurredAt,
        taskId,
      });
      return refreshActivity(s, e, from);
    }
    case "activity.started":
    case "activity.ended": {
      if (agentId === undefined) return s;
      const entry =
        e.type === "activity.started"
          ? {
              activity: e.payload.activity,
              ...(e.payload.sourceValue === undefined || e.payload.activity !== "unknown"
                ? {}
                : { sourceValue: e.payload.sourceValue }),
              heuristic: e.payload.heuristic ?? false,
              since: e.occurredAt,
              ...(e.taskId === undefined ? {} : { taskId: e.taskId }),
            }
          : { activity: "idle" as const, heuristic: false, since: e.occurredAt };
      return refreshActivity(setActivity(s, e, agentId, entry), e, agentId);
    }
    case "tool_call.started":
      return agentId === undefined ? s : applyToolCallStarted(s, e, agentId);
    case "tool_call.finished":
      return agentId === undefined ? s : applyToolCallFinished(s, e, agentId);
    case "test.result":
      if (agentId === undefined) return s;
      return setLatestEvidence(s, agentId, {
        kind: "test_result",
        eventId: e.eventId,
        at: e.occurredAt,
        passed: e.payload.passed,
        failed: e.payload.failed,
        skipped: e.payload.skipped,
      });
    default:
      // project.*, request.*, command.*, git.*: no entity effect beyond marking the agent seen.
      return s;
  }
}

function turnEffect<A extends Parameters<typeof clearLastTurn>[0]>(
  agent: A,
  type: DomainEvent["type"],
  at: string,
) {
  switch (type) {
    case "session.turn_ended":
      return setLastTurn(agent, "ended", at);
    case "session.turn_failed":
      return setLastTurn(agent, "failed", at);
    case "session.idle_prompt":
      return setLastTurn(agent, "idle_prompt", at);
    case "session.prompt_submitted":
      return clearLastTurn(agent, "prompt");
    default:
      return agent;
  }
}
