import { redactText } from "../../redact/index.ts";

/** `sourceId` of every event this adapter emits. */
export const SOURCE_ID = "claude-code";

/** Longest `session_id` accepted. Real ones are UUIDs (36 characters). */
export const MAX_SESSION_ID = 100;
/** Longest `agent_id` accepted. Real ones are 17 to about 40 characters (S-2). */
export const MAX_AGENT_ID = 64;
/** Longest `tool_use_id` accepted. Real ones are about 30 characters. */
export const MAX_TOOL_USE_ID = 128;
/**
 * Longest context `sourceEventId` accepted. Each event gets `<sourceEventId>:<event type>` and a
 * request gets `claude-code:request:<sourceEventId>`; both must fit the 200-character ID limit.
 */
export const MAX_SOURCE_EVENT_ID = 170;

// A Claude Code ID: letters, digits, `_`, `.`, `@`, `-`. No `:`, so the agent IDs built below
// cannot be confused with one another.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;

/**
 * True when `value` can be copied into an ID field. ID fields are stored unmasked (events.md
 * "Masking"), so a value the redactor would mask is refused rather than stored.
 */
export function isHookId(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    ID_PATTERN.test(value) &&
    redactText(value).spans.length === 0
  );
}

/** Agent ID of the main agent of a Claude Code session. */
export const sessionAgentId = (sessionId: string): string => `${SOURCE_ID}:${sessionId}`;

/** Agent ID of the subagent or in-process teammate `agentId` running in session `sessionId`. */
export const subagentAgentId = (sessionId: string, agentId: string): string =>
  `${SOURCE_ID}:${sessionId}:${agentId}`;

/** Request ID for a request opened by the hook with this `sourceEventId`. */
export const requestIdFor = (sourceEventId: string): string =>
  `${SOURCE_ID}:request:${sourceEventId}`;
