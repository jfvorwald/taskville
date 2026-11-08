import { type EventType, type InputEventWire, timestampSchema } from "@taskville/protocol";
import { type JsonValue, redactJson, redactText } from "../../redact/index.ts";
import { isRecord, own, ownString } from "../core/fields.ts";
import {
  isHookId,
  MAX_AGENT_ID,
  MAX_SESSION_ID,
  MAX_TOOL_USE_ID,
  sessionAgentId,
  subagentAgentId,
} from "../core/ids.ts";
import { cleanText, NAME_MAX, PATH_MAX, SUMMARY_MAX } from "../core/text.ts";
import type { ToolEvidence } from "../core/types.ts";

// Transcript mapper (M8.02, ARCHITECTURE.md 7.3, 8.1, 13). Maps the lines of one Claude Code
// session transcript (`~/.claude/projects/<slug>/<session>.jsonl`) to the same protocol v1 events
// the hook adapter produces, with `provenance: "imported"`. Pure and deterministic: time and order
// come from the lines, never a clock. Prompt and assistant prose never become events; tool input
// and output become evidence, redacted and bounded here (the evidence store redacts again).

/** `sourceId` of every event this mapper emits. */
export const TRANSCRIPT_SOURCE_ID = "claude-code:transcript";

/** The directory name Claude Code gives a project: every non-alphanumeric character becomes `-`. */
export const transcriptSlug = (root: string): string => root.replace(/[^A-Za-z0-9]/g, "-");

export type LineOutcome = "mapped" | "skipped" | "malformed";

export interface LineResult {
  outcome: LineOutcome;
  events: InputEventWire[];
  evidence?: ToolEvidence[];
}

export interface FinishResult {
  events: InputEventWire[];
  evidence?: ToolEvidence[];
}

export interface TranscriptMapper {
  /** Maps one raw line. `lineNumber` is 1-based and becomes `sourceSequence`. Never throws. */
  mapLine(raw: string, lineNumber: number): LineResult;
  /** Call once after the last line. A transcript proves no session end, so it emits nothing. */
  finish(): FinishResult;
}

/** Line types Claude Code writes that carry nothing Taskville imports. */
const KNOWN_SKIPPED_TYPES: ReadonlySet<string> = new Set([
  "summary",
  "system",
  "file-history-snapshot",
  "queue-operation",
  "progress",
  "custom-title",
  "last-prompt",
]);

/** Evidence bounds: strings are cut to this, and a whole value over the total becomes a preview. */
const EVIDENCE_STRING_MAX = 8 * 1024;
const EVIDENCE_TOTAL_MAX = 32 * 1024;
/** Deeper structure is replaced before redaction, which recurses; keeps the stack bounded. */
const EVIDENCE_DEPTH_MAX = 32;
const EVIDENCE_KEY_MAX = 256;
/** Agent or Task call lines remembered to link a subagent to its spawn. */
const SPAWN_LINES_MAX = 10_000;

interface SessionState {
  agents: Set<string>;
}

export function createTranscriptMapper(options: {
  projectId: string;
  /** Scopes `sourceEventId` to one file, so the same session in two files never collides. */
  fileId?: string;
}): TranscriptMapper {
  const { projectId, fileId = "0" } = options;
  const sessions = new Map<string, SessionState>();
  /** `toolCallId` to the agent that started it, so a result lands on the same agent. */
  const pending = new Map<string, string>();
  /** Line uuid to the agent whose Agent or Task tool_use it carries. */
  const spawns = new Map<string, string>();

  function mapLine(raw: string, lineNumber: number): LineResult {
    try {
      return mapRecord(raw, lineNumber);
    } catch {
      return malformed();
    }
  }

  function mapRecord(raw: string, lineNumber: number): LineResult {
    if (raw.trim() === "") return { outcome: "skipped", events: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return malformed();
    }
    if (!isRecord(parsed)) return malformed();
    const type = ownString(parsed, "type");
    if (type === undefined) return malformed();
    if (KNOWN_SKIPPED_TYPES.has(type)) return { outcome: "skipped", events: [] };
    if (type !== "user" && type !== "assistant") return malformed();

    const sessionId = own(parsed, "sessionId");
    const occurredAt = own(parsed, "timestamp");
    const message = own(parsed, "message");
    if (!isHookId(sessionId, MAX_SESSION_ID)) return malformed();
    if (typeof occurredAt !== "string" || !timestampSchema.safeParse(occurredAt).success) {
      return malformed();
    }
    const content = own(message, "content");
    if (!isRecord(message) || (typeof content !== "string" && !Array.isArray(content))) {
      return malformed();
    }

    const events: InputEventWire[] = [];
    const evidence: ToolEvidence[] = [];
    const emit = (agentId: string, eventType: EventType, payload: Record<string, unknown>) => {
      events.push({
        schemaVersion: 1,
        projectId,
        sourceId: TRANSCRIPT_SOURCE_ID,
        sourceEventId: `transcript:${fileId}:${lineNumber}:${events.length}:${eventType}`,
        sourceSequence: lineNumber,
        occurredAt,
        agentId,
        sessionId,
        type: eventType,
        payload,
        provenance: "imported",
        late: false,
      } as InputEventWire);
    };

    const session = sessions.get(sessionId) ?? { agents: new Set<string>() };
    sessions.set(sessionId, session);
    const mainId = sessionAgentId(sessionId);
    if (!session.agents.has(mainId)) {
      session.agents.add(mainId);
      emit(mainId, "agent.registered", {
        sourceAgentId: sessionId,
        displayName: "Claude Code",
        role: "main",
        kind: "session",
      });
      const cwd = cleanText(own(parsed, "cwd"), PATH_MAX);
      emit(mainId, "session.started", cwd === undefined ? {} : { workingDirectory: cwd });
    }

    // A sidechain line belongs to a subagent of the same session; without a usable agentId it
    // stays with the main agent.
    const sidechain = own(parsed, "isSidechain") === true;
    const sourceAgentId = own(parsed, "agentId");
    let agentId = mainId;
    if (sidechain && isHookId(sourceAgentId, MAX_AGENT_ID)) {
      agentId = subagentAgentId(sessionId, sourceAgentId);
      if (!session.agents.has(agentId)) {
        session.agents.add(agentId);
        // The parent is only what the transcript records: the first sidechain line follows the
        // line that holds the Agent or Task call.
        const parentUuid = own(parsed, "parentUuid");
        const parentAgentId = typeof parentUuid === "string" ? spawns.get(parentUuid) : undefined;
        emit(agentId, "agent.registered", {
          sourceAgentId,
          displayName: "subagent",
          role: "subagent",
          kind: "subagent",
          ...(parentAgentId === undefined ? {} : { parentAgentId }),
        });
      }
    }

    const blocks = typeof content === "string" ? [] : (content as unknown[]);
    if (type === "user") {
      let prompt = typeof content === "string";
      for (const block of blocks) {
        if (ownString(block, "type") !== "tool_result") {
          if (ownString(block, "type") === "text") prompt = true;
          continue;
        }
        const toolCallId = own(block, "tool_use_id");
        if (!isHookId(toolCallId, MAX_TOOL_USE_ID)) continue;
        const owner = pending.get(toolCallId) ?? agentId;
        pending.delete(toolCallId);
        emit(owner, "tool_call.finished", {
          toolCallId,
          phase: own(block, "is_error") === true ? "failed" : "succeeded",
        });
        const output = boundEvidence(own(block, "content"));
        if (output !== undefined) evidence.push({ toolCallId, output });
      }
      if (prompt && !sidechain && own(parsed, "isMeta") !== true) {
        emit(mainId, "session.prompt_submitted", {});
      }
    } else {
      let spawnsHere = false;
      for (const block of blocks) {
        if (ownString(block, "type") !== "tool_use") continue;
        const toolCallId = own(block, "id");
        const rawName = ownString(block, "name");
        const toolName = cleanText(rawName, NAME_MAX);
        if (rawName === "Agent" || rawName === "Task") spawnsHere = true;
        if (!isHookId(toolCallId, MAX_TOOL_USE_ID) || toolName === undefined) continue;
        const input = own(block, "input");
        const filePath = cleanText(
          own(input, "file_path") ?? own(input, "notebook_path"),
          PATH_MAX,
        );
        const summary = toolSummary(input);
        pending.set(toolCallId, agentId);
        emit(agentId, "tool_call.started", {
          toolCallId,
          toolName,
          ...(filePath === undefined ? {} : { filePaths: [filePath] }),
          ...(summary === undefined ? {} : { summary }),
        });
        const bounded = boundEvidence(input);
        if (bounded !== undefined) evidence.push({ toolCallId, input: bounded });
      }
      if (own(message, "stop_reason") === "end_turn" && !sidechain) {
        emit(mainId, "session.turn_ended", {});
      }
      const uuid = own(parsed, "uuid");
      if (typeof uuid === "string" && spawnsHere && spawns.size < SPAWN_LINES_MAX) {
        spawns.set(uuid, agentId);
      }
    }
    return done(events, evidence);
  }

  function finish(): FinishResult {
    return { events: [] };
  }

  return { mapLine, finish };
}

const malformed = (): LineResult => ({ outcome: "malformed", events: [] });

function done(events: InputEventWire[], evidence: ToolEvidence[]): LineResult {
  const outcome = events.length === 0 ? "skipped" : "mapped";
  return evidence.length === 0 ? { outcome, events } : { outcome, events, evidence };
}

/** A one-line description of a tool call from its input, if it has an obvious one. */
function toolSummary(input: unknown): string | undefined {
  for (const key of [
    "description",
    "command",
    "file_path",
    "notebook_path",
    "pattern",
    "url",
    "query",
  ]) {
    const text = cleanText(ownString(input, key), SUMMARY_MAX);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * Tool input or output for the evidence store. Depth is bounded first (redaction recurses), then
 * every complete string is redacted and property names are classified by their full text; only
 * after that are strings and keys cut. A cut can therefore never leave part of a secret. The line
 * cap bounds how large a string redaction sees.
 */
function boundEvidence(value: unknown): unknown {
  if (value === undefined) return undefined;
  const cut = shorten(redactJson(limitDepth(value, 0)).value);
  const text = JSON.stringify(cut);
  if (text === undefined || text.length <= EVIDENCE_TOTAL_MAX) return cut;
  return { truncated: true, preview: text.slice(0, EVIDENCE_STRING_MAX).toWellFormed() };
}

function limitDepth(value: unknown, depth: number): JsonValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || typeof value !== "object") return null;
  if (depth >= EVIDENCE_DEPTH_MAX) return "[truncated: nested too deeply]";
  if (Array.isArray(value)) return value.map((item) => limitDepth(item, depth + 1));
  const out: { [key: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(value)) setOwn(out, k, limitDepth(v, depth + 1));
  return out;
}

/** The final cuts, on redacted values: long strings, and keys (their text masked first). */
function shorten(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return value.length <= EVIDENCE_STRING_MAX
      ? value
      : `${value.slice(0, cutPoint(value)).toWellFormed()}...[truncated]`;
  }
  if (Array.isArray(value)) return value.map(shorten);
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      setOwn(out, redactText(k).text.slice(0, EVIDENCE_KEY_MAX).toWellFormed(), shorten(v));
    }
    return out;
  }
  return value;
}

// defineProperty, not assignment, so a "__proto__" key stays an own property.
function setOwn(target: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

const TOKEN_CHAR = /[A-Za-z0-9_+/=.-]/;
/** How far a cut inside a run of token characters backs up. */
const CUT_BACKOFF = 128;

/**
 * Where the final string cut lands. The redactor does not match a secret glued to preceding
 * letters, so a cut inside a run of token characters could leave the first part of one. It backs
 * up to the start of that run, or at most CUT_BACKOFF characters.
 */
function cutPoint(value: string): number {
  let at = EVIDENCE_STRING_MAX;
  if (!TOKEN_CHAR.test(value.charAt(at - 1)) || !TOKEN_CHAR.test(value.charAt(at))) return at;
  const floor = at - CUT_BACKOFF;
  while (at > floor && TOKEN_CHAR.test(value.charAt(at - 1))) at -= 1;
  return at;
}
