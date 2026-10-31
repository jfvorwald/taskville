import { own } from "./fields.ts";
import { isHookId, MAX_AGENT_ID, MAX_SESSION_ID, sessionAgentId, subagentAgentId } from "./ids.ts";
import type { HookSubject } from "./types.ts";

export type Attribution = { ok: true; subject: HookSubject } | { ok: false; reason: string };

/**
 * The agent a hook belongs to. A hook with `agent_id` fired inside a subagent or an in-process
 * teammate (S-2), so it belongs to that agent, in the parent's session. Otherwise it belongs to
 * the session's main agent.
 *
 * Seam for the crew mapper (M2.04): it owns what these agents are (SubagentStart, teammates,
 * split-pane linking) and may wrap this function, but must keep the same agent IDs.
 */
export function attributeHook(payload: Record<string, unknown>): Attribution {
  const sessionId = own(payload, "session_id");
  if (!isHookId(sessionId, MAX_SESSION_ID)) {
    return { ok: false, reason: "missing or invalid session_id" };
  }
  if (!Object.hasOwn(payload, "agent_id")) {
    return { ok: true, subject: { agentId: sessionAgentId(sessionId), sessionId } };
  }
  const agentId = own(payload, "agent_id");
  if (!isHookId(agentId, MAX_AGENT_ID)) return { ok: false, reason: "invalid agent_id" };
  return {
    ok: true,
    subject: { agentId: subagentAgentId(sessionId, agentId), sessionId, sourceAgentId: agentId },
  };
}
