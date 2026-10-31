import {
  MAX_AGENT_ID,
  MAX_SOURCE_EVENT_ID,
  requestIdFor,
  SOURCE_ID,
  subagentAgentId,
} from "../core/index.ts";
import {
  baseName,
  NAME_MAX as CORE_NAME_MAX,
  cleanReason,
  cleanText,
  PATH_MAX,
} from "../core/text.ts";
import { type Attribution, attributeHook, NAME_MAX } from "./attribution.ts";
import { idToken, own, ownRecord, ownString, safeText } from "./fields.ts";

// Crew mapping for Claude Code hooks: subagents and agent teams (ARCHITECTURE.md 2.9 and 8.1,
// docs/spikes/S-2-crews.md, decision #120). Pure and deterministic: one hook in, events out, no
// state across hooks. Where a link needs history the mapper emits the fact and lets the domain
// reducer join them (a registration that omits a link keeps the recorded one). The one link it
// guesses, a split-pane teammate named by its first SendMessage, and the one attribution it
// guesses, a worker permission prompt shown on the lead, carry `heuristic: true` so a strict
// attribution setting can hide them (#120 D2 alternative). Never reads ~/.claude/teams or
// ~/.claude/tasks; only the hook payload.

export interface CrewContext {
  projectId: string;
  /** The shim's ID for this hook call. Each event gets `<sourceEventId>:crew:<n>`. */
  sourceEventId: string;
  /** Engine receive time; hooks carry no timestamp, so it is also `occurredAt`. */
  receivedAt: string;
  late: boolean;
}

/**
 * A protocol v1 input event (contracts/events.md). Structurally an `InputEventWire`; the tests
 * parse every one with the protocol's schema.
 */
export interface CrewEvent {
  schemaVersion: 1;
  projectId: string;
  sourceId: typeof SOURCE_ID;
  sourceEventId: string;
  occurredAt: string;
  type: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
  provenance: "live";
  late: boolean;
}

export interface CrewMapResult {
  events: CrewEvent[];
  /** Why nothing was emitted, when nothing was. */
  ignored?: string;
}

const SUMMARY_MAX = 280;
const TITLE_MAX = 200;
const TEAM_PREFIX = `${SOURCE_ID}:team:`;
const TASK_PREFIX = `${SOURCE_ID}:task:`;
/** Protocol v1 ID limit (`ID_MAX_LENGTH`). Every ID built below is checked against it. */
const ID_MAX = 200;
/** Longest `team_name` accepted. Real ones are `session-<8 hex>`. */
const TEAM_NAME_MAX = 128;

/** `id` if it fits the protocol ID limit, else undefined. */
const fits = (id: string): string | undefined => (id.length <= ID_MAX ? id : undefined);
/** The name Claude Code gives a team's lead as a message sender or recipient. */
const LEAD_NAME = "team-lead";

type Draft = Pick<CrewEvent, "type" | "payload"> &
  Partial<Pick<CrewEvent, "agentId" | "sessionId" | "taskId">>;

const ignore = (reason: string): CrewMapResult => ({ events: [], ignored: reason });

export function mapCrewHook(payload: unknown, ctx: CrewContext): CrewMapResult {
  // The core mapper's bound: leaves room for `:crew:<n>` and `...:request:<id>:worker` in 200.
  if (ctx.sourceEventId.length > MAX_SOURCE_EVENT_ID) {
    return ignore("sourceEventId too long to derive event IDs from");
  }
  const hook = ownString(payload, "hook_event_name");
  const who = attributeHook(payload);
  if (who === undefined) return ignore("no usable session_id or agent_id");
  if (who.role === "helper") return ignore("internal helper agent");

  const drafts = draftsFor(hook, payload, who, ctx);
  if (typeof drafts === "string") return ignore(drafts);
  if (drafts.length === 0) return ignore("nothing to record");
  return {
    events: drafts.map((d, i) => ({
      schemaVersion: 1,
      projectId: ctx.projectId,
      sourceId: SOURCE_ID,
      sourceEventId: `${ctx.sourceEventId}:crew:${i}`,
      occurredAt: ctx.receivedAt,
      type: d.type,
      ...(d.agentId === undefined ? {} : { agentId: d.agentId }),
      ...(d.sessionId === undefined ? {} : { sessionId: d.sessionId }),
      ...(d.taskId === undefined ? {} : { taskId: d.taskId }),
      payload: d.payload,
      provenance: "live",
      late: ctx.late,
    })),
  };
}

function draftsFor(
  hook: string | undefined,
  p: unknown,
  who: Attribution,
  ctx: CrewContext,
): Draft[] | string {
  switch (hook) {
    case "SubagentStart":
      return subagentStart(who);
    case "SubagentStop":
      return subagentStop(p, who);
    case "TeammateIdle":
      return teammateIdle(p, who);
    case "TaskCreated":
    case "TaskCompleted":
      return teamTask(hook, p, who);
    case "PostToolUse": {
      const tool = ownString(p, "tool_name");
      if (tool === "Agent" || tool === "Task") return agentSpawned(p, who);
      if (tool === "SendMessage") return messageSent(p, who);
      return "not a crew tool";
    }
    case "Notification":
      return ownString(p, "notification_type") === "worker_permission_prompt"
        ? workerPermissionPrompt(p, who, ctx)
        : "not a crew notification";
    default:
      return "not a crew hook";
  }
}

const at = (who: Attribution) => ({ agentId: who.agentId, sessionId: who.sessionId });

/**
 * A subagent run starts. SubagentStart has no parent field (S-2), so the parent stays unknown
 * until the parent's PostToolUse(Agent) names this child. In-process teammates fire it at the
 * start of every turn; the lead's spawn response registers them, so nothing is emitted here.
 */
function subagentStart(who: Attribution): Draft[] | string {
  if (who.role !== "subagent") return "teammate turn start";
  const name = who.agentType ?? "subagent";
  return [
    {
      type: "agent.registered",
      ...at(who),
      payload: {
        sourceAgentId: who.sourceAgentId,
        displayName: name,
        role: name,
        kind: "subagent",
      },
    },
  ];
}

/** A subagent finishes. An in-process teammate's SubagentStop means idle, not gone (#120 D3). */
function subagentStop(p: unknown, who: Attribution): Draft[] | string {
  if (who.role === "teammate") return [{ type: "activity.ended", ...at(who), payload: {} }];
  if (who.role !== "subagent") return "SubagentStop without agent_id";
  const summary = safeText(own(p, "last_assistant_message"), SUMMARY_MAX);
  return [
    {
      type: "agent.finished",
      ...at(who),
      payload: summary === undefined ? {} : { summary },
    },
  ];
}

const teamIdOf = (teamName: unknown): string | undefined => {
  const name = idToken(teamName, TEAM_NAME_MAX);
  return name === undefined ? undefined : fits(`${TEAM_PREFIX}${name}`);
};

/**
 * A teammate goes idle. TeammateIdle names the teammate and its team in recorded fields, so it
 * links the agent (in-process: the lead's session plus agent_id; split-pane: its own session) to
 * its team without any guess.
 */
function teammateIdle(p: unknown, who: Attribution): Draft[] {
  const name = safeText(own(p, "teammate_name"), NAME_MAX);
  const teamId = teamIdOf(own(p, "team_name"));
  const drafts: Draft[] = [];
  if (name !== undefined) {
    drafts.push({
      type: "agent.registered",
      ...at(who),
      payload: {
        sourceAgentId: who.sourceAgentId,
        displayName: name,
        role: "teammate",
        kind: "teammate",
        ...(teamId === undefined ? {} : { teamId }),
      },
    });
  }
  drafts.push({ type: "activity.ended", ...at(who), payload: {} });
  return drafts;
}

/**
 * PostToolUse(Agent). A `teammate_spawned` response marks the caller as a team lead and, for an
 * in-process teammate, registers it under the lead's session. A split-pane teammate's agent_id
 * (`pip@session-...`) never appears in its own hooks, so registering it here would make a
 * phantom; it is linked later from its own session. Any other response with `agentId` names a
 * subagent the caller launched, which is the recorded parent link (S-2).
 */
function agentSpawned(p: unknown, who: Attribution): Draft[] | string {
  const response = ownRecord(p, "tool_response");
  if (response === undefined) return "Agent call without a response";
  if (own(response, "status") === "teammate_spawned") return teammateSpawned(p, response, who);

  const child = idToken(own(response, "agentId"), MAX_AGENT_ID);
  if (child === undefined) return "Agent response without agentId";
  const name =
    safeText(own(response, "agentType"), NAME_MAX) ??
    safeText(own(ownRecord(p, "tool_input"), "subagent_type"), NAME_MAX) ??
    "subagent";
  const childId = subagentAgentId(who.sessionId, child);
  return [
    {
      type: "agent.registered",
      agentId: childId,
      sessionId: who.sessionId,
      payload: {
        sourceAgentId: child,
        displayName: name,
        role: name,
        kind: "subagent",
        parentAgentId: who.agentId,
      },
    },
  ];
}

function teammateSpawned(
  p: unknown,
  response: Record<string, unknown>,
  who: Attribution,
): Draft[] | string {
  // Teammates cannot spawn teammates, so only a session's own agent can lead.
  if (who.role !== "session") return "teammate spawn from a non-session agent";
  const teamName = idToken(own(response, "team_name"), TEAM_NAME_MAX);
  const teamId = teamIdOf(teamName);
  if (teamName === undefined || teamId === undefined) return "teammate spawn without team_name";
  const drafts: Draft[] = [
    {
      type: "team.started",
      ...at(who),
      payload: { teamId, leadAgentId: who.agentId, name: teamName },
    },
    {
      type: "agent.registered",
      ...at(who),
      payload: {
        sourceAgentId: who.sourceAgentId,
        // The same name the core mapper gives the session on SessionStart, so becoming a lead
        // does not rename it.
        displayName: sessionDisplayName(p),
        role: "lead",
        kind: "lead",
        teamId,
      },
    },
  ];
  const inProcess = own(response, "is_splitpane") === false;
  const agentId = idToken(own(response, "agent_id"), MAX_AGENT_ID);
  const name = safeText(own(response, "name"), NAME_MAX);
  if (inProcess && agentId !== undefined && name !== undefined) {
    const teammateId = subagentAgentId(who.sessionId, agentId);
    drafts.push({
      type: "agent.registered",
      agentId: teammateId,
      sessionId: who.sessionId,
      payload: {
        sourceAgentId: agentId,
        displayName: name,
        role: "teammate",
        kind: "teammate",
        teamId,
      },
    });
  }
  return drafts;
}

const MESSAGE_KINDS = new Set(["message", "shutdown_request", "shutdown_response"]);

/**
 * PostToolUse(SendMessage) that succeeded: a message from the calling agent. The body stays in
 * the tool-call evidence; the event carries the recipient, kind, and masked summary. A split-pane
 * teammate is its own session with no agent_id, so its first message is the earliest hook that
 * names it (`routing.sender`); that link is a guess (any session can message a peer), so it is
 * marked heuristic and carries no team, which only TeammateIdle records.
 */
function messageSent(p: unknown, who: Attribution): Draft[] | string {
  const response = ownRecord(p, "tool_response");
  if (own(response, "success") !== true) return "SendMessage did not succeed";
  const input = ownRecord(p, "tool_input");
  const to = safeText(own(input, "to"), NAME_MAX);
  if (to === undefined) return "SendMessage without a recipient";

  const body = own(input, "message");
  const bodyType = ownString(body, "type");
  const kind =
    typeof body === "string"
      ? "message"
      : bodyType !== undefined && MESSAGE_KINDS.has(bodyType)
        ? bodyType
        : "unknown";
  const summary = safeText(own(input, "summary"), SUMMARY_MAX);
  const drafts: Draft[] = [
    {
      type: "team.message",
      ...at(who),
      payload: { to, kind, ...(summary === undefined ? {} : { summary }) },
    },
  ];

  const sender = safeText(own(ownRecord(response, "routing"), "sender"), NAME_MAX);
  if (who.role === "session" && sender !== undefined && sender !== LEAD_NAME) {
    drafts.push({
      type: "agent.registered",
      ...at(who),
      payload: {
        sourceAgentId: who.sourceAgentId,
        displayName: sender,
        role: "teammate",
        kind: "teammate",
        heuristic: true,
      },
    });
  }
  return drafts;
}

/** The core mapper's session name (core/map.ts sessionStart), so becoming a lead keeps it. */
function sessionDisplayName(p: unknown): string {
  const cwd = cleanText(own(p, "cwd"), PATH_MAX);
  return (cwd === undefined ? undefined : cleanText(baseName(cwd), CORE_NAME_MAX)) ?? "Claude Code";
}

// "pip needs permission for Bash" (S-2 answer 3). English text a Claude Code update could change.
const WORKER_PROMPT = /^(\S[^\n]{0,63}?) needs permission for (\S[^\n]{0,63})$/;

/**
 * A split-pane teammate hit a permission prompt. No PermissionRequest fires, so the bridge cannot
 * answer it; the lead's session gets this notification and the prompt is answered in the lead's
 * terminal. Per #120 the lead turns red "for: <name>", with the name parsed from English text, so
 * the request is heuristic. It is never answerable: only `taskville:bridge` requests are.
 */
function workerPermissionPrompt(p: unknown, who: Attribution, ctx: CrewContext): Draft[] | string {
  if (who.role !== "session") return "worker prompt outside a lead session";
  const message = ownString(p, "message");
  const match = message === undefined ? null : WORKER_PROMPT.exec(message.slice(0, 256));
  // Like the core mapper's reasons, this one goes to the engine unmasked so the engine masks it
  // and records `masked: true` (FR-017); the regex already bounds both parts to 64 characters.
  const name = match?.[1]?.toWellFormed();
  const tool = match?.[2]?.toWellFormed();
  const reason = cleanReason(
    `for: ${name ?? "a teammate"}${tool === undefined ? "" : ` (${tool})`}`,
  );
  // No toolName: the lead's `permission_prompt` notification that follows (core mapper) has none
  // either, so the reducer merges the two into one red state ("one prompt, one red state").
  return [
    {
      type: "request.opened",
      ...at(who),
      payload: {
        // One request per notification; a retried hook keeps its sourceEventId, so its ID too.
        requestId: `${requestIdFor(ctx.sourceEventId)}:worker`,
        kind: "permission",
        ...(reason === undefined ? {} : { reason }),
        heuristic: true,
      },
    },
  ];
}

/**
 * TaskCreated and TaskCompleted: the team's shared task list. Not recorded in S-2 (the task tools
 * were unavailable in 2.1.312), so the field names are the documented ones (`task_id`,
 * `task_subject`, `team_name`) and unverified. Tasks are scoped by team, else by session.
 */
function teamTask(
  hook: "TaskCreated" | "TaskCompleted",
  p: unknown,
  who: Attribution,
): Draft[] | string {
  const taskKey = idToken(own(p, "task_id"), MAX_AGENT_ID);
  if (taskKey === undefined) return `${hook} without task_id`;
  const scope = idToken(own(p, "team_name"), TEAM_NAME_MAX) ?? who.sessionId;
  const taskId = fits(`${TASK_PREFIX}${scope}:${taskKey}`);
  if (taskId === undefined) return `${hook} task ID too long`;
  if (hook === "TaskCreated") {
    const title = safeText(own(p, "task_subject"), TITLE_MAX) ?? `Task ${taskKey}`;
    return [{ type: "task.created", ...at(who), taskId, payload: { title } }];
  }
  return [{ type: "task.status_changed", ...at(who), taskId, payload: { status: "completed" } }];
}
