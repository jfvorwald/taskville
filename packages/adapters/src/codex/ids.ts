/** `sourceId` of every event this adapter emits. */
export const SOURCE_ID = "codex";

// ID bounds, the ID check, and the ID character rules are the Claude Code mapper's: both read
// plain tokens from untrusted hook JSON. Only the `codex:` prefix differs, so a Codex agent ID
// can never equal a Claude Code one.
export {
  isHookId,
  MAX_AGENT_ID,
  MAX_SESSION_ID,
  MAX_SOURCE_EVENT_ID,
  MAX_TOOL_USE_ID,
} from "../claude-code/core/index.ts";

/** Agent ID of the main agent of a Codex session. */
export const sessionAgentId = (sessionId: string): string => `${SOURCE_ID}:${sessionId}`;

/** Agent ID of the subagent `agentId` (the child thread ID) running in session `sessionId`. */
export const subagentAgentId = (sessionId: string, agentId: string): string =>
  `${SOURCE_ID}:${sessionId}:${agentId}`;

/** Request ID for a request opened by the hook with this `sourceEventId`. */
export const requestIdFor = (sourceEventId: string): string =>
  `${SOURCE_ID}:request:${sourceEventId}`;
