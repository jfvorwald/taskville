import { idToken, isRecord, own, ownString, safeText } from "./fields.ts";

// Which agent a Claude Code hook belongs to (ARCHITECTURE.md 8.1 Mapping, docs/spikes/S-2-crews.md,
// decision #120 D1). Uses only fields of the one hook, so the mapper stays pure.
//
// - No `agent_id`: the session's own agent (the main session, a lead, or a split-pane teammate,
//   which is its own session).
// - `agent_id` with a non-empty `agent_type`: a subagent, or an in-process teammate when the id
//   is `a<agent_type>-<16 hex>` (S-2 answer 2: teammates are `apip-5cb5e9bb3f2f1097` with
//   `agent_type` "pip"; subagents are `a` plus 17 hex digits). Both live in the session that fired
//   the hook, so the agent is `(session_id, agent_id)`.
// - `agent_id` with an empty or missing `agent_type`: an internal helper agent (prompt
//   suggestions and the like) that never had a SubagentStart. S-2 says to ignore these.

export type HookRole = "session" | "subagent" | "teammate" | "helper";

export interface Attribution {
  role: HookRole;
  /** Envelope `agentId`. */
  agentId: string;
  /**
   * The agent's `sourceAgentId`, as the core mapper registers it: the `session_id` for a
   * session's own agent, the hook's `agent_id` for a subagent or teammate. Identity is
   * `(sourceId, sourceAgentId)` and a second claim on an agent ID is ignored, so both mappers
   * must agree.
   */
  sourceAgentId: string;
  /** Envelope `sessionId`: the Claude Code `session_id`. */
  sessionId: string;
  /** Masked and bounded `agent_type`, for subagents and in-process teammates. */
  agentType?: string;
}

/**
 * Bounds on IDs taken from hooks, and the agent ID scheme, match the core mapper (M2.03, #22:
 * `core/ids.ts`) so both mappers name the same agent the same way.
 */
export const SESSION_ID_MAX = 100;
export const AGENT_ID_MAX = 64;
/** Display names (`agent_type`, teammate names). */
export const NAME_MAX = 64;

const AGENT_PREFIX = "claude-code:";

/** The agent ID for a session's own agent. */
export const sessionAgentId = (sessionId: string): string => `${AGENT_PREFIX}${sessionId}`;

/** The agent ID for a subagent or in-process teammate of a session. */
export const childAgentId = (sessionId: string, agentId: string): string =>
  `${AGENT_PREFIX}${sessionId}:${agentId}`;

const TEAMMATE_SUFFIX = /^-[0-9a-f]{16}$/;

/** True when `agentId` is `a<agentType>-<16 hex>`, the in-process teammate id shape. */
export function isTeammateAgentId(agentId: string, agentType: string): boolean {
  const prefix = `a${agentType}`;
  return (
    agentType !== "" &&
    agentId.startsWith(prefix) &&
    TEAMMATE_SUFFIX.test(agentId.slice(prefix.length))
  );
}

export function attributeHook(payload: unknown): Attribution | undefined {
  if (!isRecord(payload)) return undefined;
  const sessionId = idToken(own(payload, "session_id"), SESSION_ID_MAX);
  if (sessionId === undefined) return undefined;

  const rawAgentId = own(payload, "agent_id");
  if (rawAgentId === undefined) {
    return {
      role: "session",
      sessionId,
      agentId: sessionAgentId(sessionId),
      sourceAgentId: sessionId,
    };
  }
  const agentId = idToken(rawAgentId, AGENT_ID_MAX);
  if (agentId === undefined) return undefined;

  const id = childAgentId(sessionId, agentId);
  const rawType = ownString(payload, "agent_type") ?? "";
  const agentType = safeText(rawType, NAME_MAX);
  if (agentType === undefined) {
    return { role: "helper", sessionId, agentId: id, sourceAgentId: agentId };
  }
  const role = isTeammateAgentId(agentId, rawType) ? "teammate" : "subagent";
  return { role, sessionId, agentId: id, sourceAgentId: agentId, agentType };
}
