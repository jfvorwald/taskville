import { type EventType, INPUT_PREVIEW_MAX_CHARS, type InputEventWire } from "@taskville/protocol";
import { activityForTool } from "./activity.ts";
import { attributeHook } from "./attribution.ts";
import { isRecord, own, ownString } from "./fields.ts";
import { isHookId, MAX_SOURCE_EVENT_ID, MAX_TOOL_USE_ID, requestIdFor, SOURCE_ID } from "./ids.ts";
import {
  baseName,
  cleanReason,
  cleanText,
  firstLine,
  NAME_MAX,
  PATH_MAX,
  SUMMARY_MAX,
} from "./text.ts";
import type { HookContext, HookSubject, MapResult, ToolEvidence } from "./types.ts";

// The core Claude Code mapper (M2.03): sessions, prompts, tool calls, notifications, turn ends,
// and elicitations, from one raw hook payload to protocol v1 input events (ARCHITECTURE.md 8.1).
// Pure: no I/O, clock, or randomness, so the same payload and context always give the same
// events. Stateless: Pre and Post tool hooks pair through `toolCallId = tool_use_id`, so a
// missing PostToolUse leaves a running ToolCall and a Post without its Pre still maps.

/** Hooks the crew mapper (M2.04) owns: subagent and agent-team lifecycle. */
export const CREW_HOOKS: ReadonlySet<string> = new Set([
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
]);

/** Longest `prompt_id` accepted. Real ones are UUIDs. */
const MAX_PROMPT_ID = 100;

/** Longest accepted tool duration: 30 days (L-39). */
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

type Payload<T extends EventType> = Extract<InputEventWire, { type: T }>["payload"];

interface Mapping {
  hook: string;
  payload: Record<string, unknown>;
  subject: HookSubject;
  ctx: HookContext;
}

const ignore = (reason: string): MapResult => ({ events: [], ignored: reason });

/** Maps one raw hook payload. Hooks other mappers own come back `ignored`. */
export function mapCoreHook(payload: unknown, ctx: HookContext): MapResult {
  if (!isRecord(payload)) return ignore("payload is not a JSON object");
  const hook = ownString(payload, "hook_event_name");
  if (hook === undefined) return ignore("missing hook_event_name");
  if (CREW_HOOKS.has(hook)) return ignore(`${hook} belongs to the crew mapper (M2.04)`);
  if (!CORE_HOOKS.has(hook)) {
    return ignore(OTHER_HOOKS.get(hook) ?? "hook not handled by this mapper");
  }
  if (ctx.sourceEventId.length > MAX_SOURCE_EVENT_ID) {
    return ignore("sourceEventId too long to derive event IDs from");
  }
  const attribution = attributeHook(payload);
  if (!attribution.ok) return ignore(attribution.reason);
  const m: Mapping = { hook, payload, subject: attribution.subject, ctx };
  if (m.subject.sourceAgentId !== undefined && isSessionHook(hook, payload)) {
    // A session's lifecycle belongs to its main agent. Session hooks are not recorded from
    // inside a subagent (S-2); if one came, emitting it under the subagent would let the reducer
    // record the parent's session as the subagent's, so it is left to the crew mapper.
    return ignore(`${hook} from inside an agent belongs to the crew mapper (M2.04)`);
  }

  switch (hook) {
    case "SessionStart":
      return sessionStart(m);
    case "SessionEnd":
      return result([
        event(m, "session.ended", optional("outcome", cleanText(own(payload, "reason"), NAME_MAX))),
      ]);
    case "UserPromptSubmit":
      return result([event(m, "session.prompt_submitted", {})]);
    case "Stop":
      return result([event(m, "session.turn_ended", {}), event(m, "activity.ended", {})]);
    case "StopFailure":
      return result([
        event(m, "session.turn_failed", optional("reason", stopFailureReason(payload))),
        event(m, "activity.ended", {}),
      ]);
    case "Notification":
      return notification(m);
    case "Elicitation":
      return elicitation(m);
    default:
      return toolHook(m);
  }
}

const CORE_HOOKS: ReadonlySet<string> = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "Notification",
  "Elicitation",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
]);

const OTHER_HOOKS: ReadonlyMap<string, string> = new Map([
  ["PermissionRequest", "PermissionRequest belongs to the permission bridge (M4)"],
  ["MessageDisplay", "MessageDisplay belongs to the agent feed (M5)"],
  ["ElicitationResult", "ElicitationResult: the next session event closes the request"],
]);

/** Hooks that emit `session.*` events. */
function isSessionHook(hook: string, payload: Record<string, unknown>): boolean {
  if (hook === "Notification") return ownString(payload, "notification_type") === "idle_prompt";
  return (
    hook === "SessionStart" ||
    hook === "SessionEnd" ||
    hook === "UserPromptSubmit" ||
    hook === "Stop" ||
    hook === "StopFailure"
  );
}

function sessionStart(m: Mapping): MapResult {
  const cwd = cleanText(own(m.payload, "cwd"), PATH_MAX);
  const name = cwd === undefined ? undefined : cleanText(baseName(cwd), NAME_MAX);
  return result([
    event(m, "agent.registered", {
      sourceAgentId: m.subject.sessionId,
      displayName: name ?? "Claude Code",
      role: cleanText(own(m.payload, "agent_type"), NAME_MAX) ?? "main",
      kind: "session",
    }),
    event(m, "session.started", optional("workingDirectory", cwd)),
  ]);
}

function stopFailureReason(payload: Record<string, unknown>): string | undefined {
  const error = ownString(payload, "error");
  if (error === undefined) return undefined;
  const details = ownString(payload, "error_details");
  return cleanReason(details === undefined ? error : `${error}: ${details}`);
}

function notification(m: Mapping): MapResult {
  const type = ownString(m.payload, "notification_type");
  if (type === "idle_prompt") return result([event(m, "session.idle_prompt", {})]);
  if (type === "permission_prompt") {
    // Telemetry only: never answerable (only the M4 bridge's requests are). A late payload is
    // marked late, and the reducer records a late request as expired, never as needs-you.
    return result([
      event(
        m,
        "request.opened",
        {
          requestId: requestIdFor(m.ctx.sourceEventId),
          kind: "permission",
          ...optional("reason", cleanReason(own(m.payload, "message"))),
        },
        promptId(m.payload),
      ),
    ]);
  }
  if (type === "worker_permission_prompt") {
    return ignore("worker_permission_prompt belongs to the crew mapper (M2.04)");
  }
  return ignore("notification type not handled");
}

function elicitation(m: Mapping): MapResult {
  const server = ownString(m.payload, "mcp_server_name");
  const message = ownString(m.payload, "message");
  const text =
    server !== undefined && message !== undefined ? `${server}: ${message}` : (message ?? server);
  return result([
    event(
      m,
      "request.opened",
      {
        requestId: requestIdFor(m.ctx.sourceEventId),
        kind: "elicitation",
        ...optional("reason", cleanReason(text)),
      },
      promptId(m.payload),
    ),
  ]);
}

function toolHook(m: Mapping): MapResult {
  const toolCallId = own(m.payload, "tool_use_id");
  if (!isHookId(toolCallId, MAX_TOOL_USE_ID)) return ignore("missing or invalid tool_use_id");
  const toolName = cleanText(own(m.payload, "tool_name"), NAME_MAX);
  const rawToolName = ownString(m.payload, "tool_name");
  if (toolName === undefined || rawToolName === undefined) return ignore("missing tool_name");
  const input = own(m.payload, "tool_input");

  if (m.hook === "PreToolUse") {
    const filePath = cleanText(own(input, "file_path") ?? own(input, "notebook_path"), PATH_MAX);
    const events = [
      event(m, "tool_call.started", {
        toolCallId,
        toolName,
        ...optional("filePaths", filePath === undefined ? undefined : [filePath]),
        ...optional("summary", toolSummary(rawToolName, input)),
      }),
    ];
    const activity = activityForTool(rawToolName, input);
    if (activity !== undefined) events.push(event(m, "activity.started", activity));
    return result(events, input === undefined ? undefined : [{ toolCallId, input }]);
  }

  const failed = m.hook === "PostToolUseFailure";
  const output = failed ? failureOutput(m.payload) : own(m.payload, "tool_response");
  const summary = failed
    ? firstLine(cleanText(own(m.payload, "error"), INPUT_PREVIEW_MAX_CHARS))
    : undefined;
  const finished = event(m, "tool_call.finished", {
    toolCallId,
    phase: failed ? "failed" : "succeeded",
    ...optional("durationMs", durationMs(own(m.payload, "duration_ms"))),
    ...optional("summary", summary === undefined ? undefined : cleanText(summary, SUMMARY_MAX)),
  });
  return result([finished], output === undefined ? undefined : [{ toolCallId, output }]);
}

/** A one-line description of a tool call from its input, if the tool has an obvious one. */
function toolSummary(toolName: string, input: unknown): string | undefined {
  let text: string | undefined;
  switch (toolName) {
    case "Bash":
      text = ownString(input, "description") ?? ownString(input, "command");
      break;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "Read":
      text = ownString(input, "file_path");
      break;
    case "NotebookEdit":
      text = ownString(input, "notebook_path");
      break;
    case "Grep":
    case "Glob":
      text = ownString(input, "pattern");
      break;
    case "WebFetch":
      text = ownString(input, "url");
      break;
    case "WebSearch":
      text = ownString(input, "query");
      break;
    case "Agent":
    case "Task":
      text = ownString(input, "description");
      break;
    default:
      text = undefined;
  }
  return cleanText(text, SUMMARY_MAX);
}

/**
 * The hook's `prompt_id`, shared by the PermissionRequest, Notification, and PostToolUse of one
 * prompt (S-1). Carried as `correlationId` on requests so the bridge's request (M4) can be
 * matched to the telemetry one; matching is not done here.
 */
function promptId(payload: Record<string, unknown>): string | undefined {
  const id = own(payload, "prompt_id");
  return isHookId(id, MAX_PROMPT_ID) ? id : undefined;
}

function failureOutput(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of ["error", "is_interrupt"]) {
    if (Object.hasOwn(payload, key)) out[key] = payload[key];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function durationMs(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DURATION_MS
    ? value
    : undefined;
}

function event<T extends EventType>(
  m: Mapping,
  type: T,
  payload: Payload<T>,
  correlationId?: string,
): InputEventWire {
  return {
    schemaVersion: 1,
    projectId: m.ctx.projectId,
    sourceId: SOURCE_ID,
    sourceEventId: `${m.ctx.sourceEventId}:${type}`,
    occurredAt: m.ctx.receivedAt,
    agentId: m.subject.agentId,
    sessionId: m.subject.sessionId,
    ...optional("correlationId", correlationId),
    type,
    payload,
    provenance: "live",
    late: m.ctx.late,
  } as InputEventWire;
}

function result(events: InputEventWire[], evidence?: ToolEvidence[]): MapResult {
  return evidence === undefined ? { events } : { events, evidence };
}

/** `{ [key]: value }`, or `{}` when value is undefined (exactOptionalPropertyTypes). */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
