import { type EventType, INPUT_PREVIEW_MAX_CHARS, type InputEventWire } from "@taskville/protocol";
import { own, ownString } from "../claude-code/core/fields.ts";
import { activityForTool, type HookContext, type MapResult } from "../claude-code/core/index.ts";
import {
  cleanReason,
  cleanText,
  firstLine,
  NAME_MAX,
  PATH_MAX,
  SUMMARY_MAX,
} from "../claude-code/core/text.ts";
import {
  isHookId,
  MAX_AGENT_ID,
  MAX_SESSION_ID,
  MAX_SOURCE_EVENT_ID,
  MAX_TOOL_USE_ID,
  requestIdFor,
  SOURCE_ID,
  sessionAgentId,
  subagentAgentId,
} from "./ids.ts";

// The Codex hook mapper (A1.01, docs/spikes/S-5-codex.md "Draft mapping"): one raw hook payload
// to protocol v1 input events. Pure and stateless, like the Claude Code mapper. What it needs
// from history comes in through the context, which the engine fills from its own records.
//
// Privacy: prompts, final messages, transcript paths, and tool output are never copied. A Bash
// call is carried as its first command line only.

/** A tool call the engine has seen start and not finish. */
export interface OpenToolCall {
  toolCallId: string;
  /** The `turn_id` the call started in, if its hook had one. */
  turnId?: string;
  /** The hook `agent_id` of a subagent's call, if any. */
  sourceAgentId?: string;
}

export interface CodexHookContext extends HookContext {
  /** False when the engine never saw this session start. Absent means known. */
  knownSession?: boolean;
  /** Tool calls started and not finished. Accepted for the engine to fill; the mapper does not use it. */
  openToolCalls?: readonly OpenToolCall[];
}

interface Subject {
  agentId: string;
  sessionId: string;
  /** The hook's `agent_id`, present when the hook fired inside a subagent. */
  sourceAgentId?: string;
}

interface Mapping {
  payload: Record<string, unknown>;
  subject: Subject;
  ctx: CodexHookContext;
}

type Payload<T extends EventType> = Extract<InputEventWire, { type: T }>["payload"];

const ignore = (reason: string): MapResult => ({ events: [], ignored: reason });

const SESSION_HOOKS: ReadonlySet<string> = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
]);
const HANDLED_HOOKS: ReadonlySet<string> = new Set([
  ...SESSION_HOOKS,
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
]);

/** Codex glues the tool namespace onto subagent tool names: `collaborationspawn_agent`. */
const NAMESPACE_PREFIX = "collaboration";
/** Characters of an `agent_id` shown as the subagent's name. */
const SHORT_ID = 8;

/** Maps one raw Codex hook payload. Hooks this mapper does not use come back `ignored`. */
export function mapCodexHook(payload: unknown, ctx: CodexHookContext): MapResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return ignore("payload is not a JSON object");
  }
  const p = payload as Record<string, unknown>;
  const hook = ownString(p, "hook_event_name");
  if (hook === undefined) return ignore("missing hook_event_name");
  if (!HANDLED_HOOKS.has(hook)) {
    return ignore(
      hook === "PreModelRequest" || hook === "PostModelRequest"
        ? `${hook} carries tokens only; no token event in protocol v1`
        : "hook not handled by this mapper",
    );
  }
  if (ctx.sourceEventId.length > MAX_SOURCE_EVENT_ID) {
    return ignore("sourceEventId too long to derive event IDs from");
  }
  const subject = attribute(p);
  if (typeof subject === "string") return ignore(subject);
  const m: Mapping = { payload: p, subject, ctx };
  if (subject.sourceAgentId !== undefined && SESSION_HOOKS.has(hook)) {
    // Session hooks are not recorded from inside a subagent; emitting one under the subagent
    // would let the reducer record the parent's session as the subagent's.
    return ignore(`${hook} from inside an agent is not a session event`);
  }

  switch (hook) {
    case "SessionStart":
      return sessionStart(m);
    case "SessionEnd":
      if (ctx.knownSession === false) return ignore("SessionEnd for a session never seen start");
      return result([event(m, "session.ended", optional("outcome", outcome(p)))]);
    case "UserPromptSubmit":
      return result([event(m, "session.prompt_submitted", {})]);
    case "Stop":
      return result([event(m, "session.turn_ended", {}), event(m, "activity.ended", {})]);
    case "Interrupt":
      return interrupt(m);
    case "PermissionRequest":
      return permissionRequest(m);
    case "SubagentStart":
      return subagentStart(m);
    case "SubagentStop":
      return subagentStop(m);
    default:
      return toolHook(m, hook);
  }
}

/** The agent a hook belongs to, or why it cannot be told. */
function attribute(p: Record<string, unknown>): Subject | string {
  const sessionId = own(p, "session_id");
  if (!isHookId(sessionId, MAX_SESSION_ID)) return "missing or invalid session_id";
  if (!Object.hasOwn(p, "agent_id")) return { agentId: sessionAgentId(sessionId), sessionId };
  const agentId = own(p, "agent_id");
  if (!isHookId(agentId, MAX_AGENT_ID)) return "invalid agent_id";
  return {
    agentId: subagentAgentId(sessionId, agentId),
    sessionId,
    sourceAgentId: agentId,
  };
}

const outcome = (p: Record<string, unknown>) => cleanText(own(p, "reason"), NAME_MAX);

function sessionStart(m: Mapping): MapResult {
  // A compact keeps the same session going, so it must not start a new one.
  if (ownString(m.payload, "source") === "compact") return ignore("SessionStart from a compact");
  const cwd = cleanText(own(m.payload, "cwd"), PATH_MAX);
  return result([
    event(m, "agent.registered", {
      sourceAgentId: m.subject.sessionId,
      displayName: cleanText(m.ctx.ownerName, NAME_MAX) ?? "Codex",
      role: "main",
      kind: "session",
    }),
    event(m, "session.started", optional("workingDirectory", cwd)),
  ]);
}

/**
 * The user interrupted the turn. Codex sends no Stop for it and no PostToolUse for a denied
 * call. No tool_call.finished is emitted: the domain closes the main agent's running calls as
 * unfinished on turn_failed, and a subagent's on agent.finished, so nothing is claimed here.
 * `ctx.openToolCalls` is accepted but not needed.
 */
function interrupt(m: Mapping): MapResult {
  return result([
    event(m, "session.turn_failed", { reason: "interrupted" }),
    event(m, "activity.ended", {}),
  ]);
}

function permissionRequest(m: Mapping): MapResult {
  const toolName = stripNamespace(ownString(m.payload, "tool_name"));
  const input = own(m.payload, "tool_input");
  return result([
    event(m, "request.opened", {
      requestId: requestIdFor(m.ctx.sourceEventId),
      kind: "permission",
      ...optional("toolName", cleanText(toolName, NAME_MAX)),
      ...optional("inputPreview", cleanText(own(input, "command"), INPUT_PREVIEW_MAX_CHARS)),
      ...optional("reason", cleanReason(own(input, "description"))),
    }),
  ]);
}

/**
 * The subagent is named by a short form of its `agent_id`. Nothing in the hooks links a spawn
 * to its child, so a name from spawn order would mislabel parallel subagents (S-5 gap 6).
 */
function subagentStart(m: Mapping): MapResult {
  const child = m.subject.sourceAgentId;
  if (child === undefined) return ignore("SubagentStart without agent_id");
  return result([
    event(m, "agent.registered", {
      sourceAgentId: child,
      displayName: child.slice(0, SHORT_ID),
      role: cleanText(own(m.payload, "agent_type"), NAME_MAX) ?? "subagent",
      kind: "subagent",
      parentAgentId: sessionAgentId(m.subject.sessionId),
    }),
    event(m, "agent.connected", {}),
  ]);
}

function subagentStop(m: Mapping): MapResult {
  if (m.subject.sourceAgentId === undefined) return ignore("SubagentStop without agent_id");
  return result([event(m, "agent.finished", {})]);
}

function toolHook(m: Mapping, hook: string): MapResult {
  const toolCallId = own(m.payload, "tool_use_id");
  if (!isHookId(toolCallId, MAX_TOOL_USE_ID)) return ignore("missing or invalid tool_use_id");
  const rawName = ownString(m.payload, "tool_name");
  const toolName = cleanText(stripNamespace(rawName), NAME_MAX);
  if (rawName === undefined || toolName === undefined) return ignore("missing tool_name");

  if (hook === "PostToolUse") {
    // A Post only says the tool returned. Codex gives no exit code for Bash, so `succeeded`
    // would be a claim without evidence (S-5 gap 3).
    return result([event(m, "tool_call.finished", { toolCallId, phase: "returned" })]);
  }

  const input = own(m.payload, "tool_input");
  const filePaths = rawName === "apply_patch" ? patchPaths(ownString(input, "command")) : [];
  const events = [
    event(m, "tool_call.started", {
      toolCallId,
      toolName,
      ...(filePaths.length === 0 ? {} : { filePaths }),
      ...optional("summary", rawName === "Bash" ? commandSummary(input) : undefined),
    }),
  ];
  const activity = activityFor(toolName, input);
  if (activity !== undefined) events.push(event(m, "activity.started", activity));
  return result(events);
}

function activityFor(toolName: string, input: unknown) {
  if (toolName === "apply_patch") return { activity: "implementing" as const };
  if (toolName === "spawn_agent") return { activity: "dispatching" as const };
  // The default for an MCP tool is a guess: its purpose is the server's, not known here.
  if (toolName.startsWith("mcp__")) {
    return { activity: "researching" as const, heuristic: true as const };
  }
  return activityForTool(toolName, input);
}

const stripNamespace = (name: string | undefined): string | undefined =>
  name?.startsWith(NAMESPACE_PREFIX) && name.length > NAMESPACE_PREFIX.length
    ? name.slice(NAMESPACE_PREFIX.length)
    : name;

const commandSummary = (input: unknown): string | undefined =>
  cleanText(firstLine(cleanText(ownString(input, "command"), SUMMARY_MAX)), SUMMARY_MAX);

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

/** The absolute paths named by an apply_patch patch's file headers, in order, once each. */
function patchPaths(patch: string | undefined): string[] {
  if (patch === undefined) return [];
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const path = cleanText(PATCH_HEADER.exec(line)?.[1], PATH_MAX);
    if (path !== undefined && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function event<T extends EventType>(m: Mapping, type: T, payload: Payload<T>): InputEventWire {
  return {
    schemaVersion: 1,
    projectId: m.ctx.projectId,
    sourceId: SOURCE_ID,
    sourceEventId: `${m.ctx.sourceEventId}:${type}`,
    occurredAt: m.ctx.receivedAt,
    agentId: m.subject.agentId,
    sessionId: m.subject.sessionId,
    type,
    payload,
    provenance: "live",
    late: m.ctx.late,
  } as InputEventWire;
}

const result = (events: InputEventWire[]): MapResult => ({ events });

/** `{ [key]: value }`, or `{}` when value is undefined (exactOptionalPropertyTypes). */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
