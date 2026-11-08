import { type EventType, type InputEventWire, timestampSchema } from "@taskville/protocol";
import { type JsonValue, redactJson } from "../../redact/index.ts";
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
  /** Call once after the last line: emits `session.ended` for sessions that finished cleanly. */
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

interface SessionState {
  agents: Set<string>;
  /** Line and time of the latest turn end, cleared when the session does anything after it. */
  ended?: { lineNumber: number; occurredAt: string } | undefined;
}

export function createTranscriptMapper(options: { projectId: string }): TranscriptMapper {
  const { projectId } = options;
  const sessions = new Map<string, SessionState>();
  /** `toolCallId` to the agent that started it, so a result lands on the same agent. */
  const pending = new Map<string, string>();
  let lastMalformed = false;

  function mapLine(raw: string, lineNumber: number): LineResult {
    const result = mapRecord(raw, lineNumber);
    lastMalformed = result.outcome === "malformed";
    return result;
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
        sourceEventId: `transcript:${sessionId}:${lineNumber}:${events.length}:${eventType}`,
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
        emit(agentId, "agent.registered", {
          sourceAgentId,
          displayName: "subagent",
          role: "subagent",
          kind: "subagent",
          parentAgentId: mainId,
        });
      }
    }

    const blocks = typeof content === "string" ? [] : (content as unknown[]);
    let didAnything = false;
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
        didAnything = true;
      }
      if (prompt && !sidechain && own(parsed, "isMeta") !== true) {
        emit(mainId, "session.prompt_submitted", {});
        didAnything = true;
      }
    } else {
      for (const block of blocks) {
        if (ownString(block, "type") !== "tool_use") continue;
        const toolCallId = own(block, "id");
        const rawName = ownString(block, "name");
        const toolName = cleanText(rawName, NAME_MAX);
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
        didAnything = true;
      }
      if (own(message, "stop_reason") === "end_turn" && !sidechain) {
        emit(mainId, "session.turn_ended", {});
        session.ended = { lineNumber, occurredAt };
        return done(events, evidence);
      }
    }
    if (didAnything) session.ended = undefined;
    return done(events, evidence);
  }

  function finish(): FinishResult {
    const events: InputEventWire[] = [];
    // A transcript cut mid-line says nothing about how its session ended.
    if (!lastMalformed) {
      for (const [sessionId, session] of sessions) {
        if (session.ended === undefined) continue;
        events.push({
          schemaVersion: 1,
          projectId,
          sourceId: TRANSCRIPT_SOURCE_ID,
          sourceEventId: `transcript:${sessionId}:ended`,
          sourceSequence: session.ended.lineNumber,
          occurredAt: session.ended.occurredAt,
          agentId: sessionAgentId(sessionId),
          sessionId,
          type: "session.ended",
          payload: {},
          provenance: "imported",
          late: false,
        } as InputEventWire);
      }
    }
    return { events };
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
 * Tool input or output for the evidence store: secrets masked first, then long strings cut and,
 * if the whole value is still large, replaced by a preview of its JSON. Redacting before cutting
 * means a cut never leaves part of a secret.
 */
function boundEvidence(value: unknown): unknown {
  if (value === undefined) return undefined;
  const masked = redactJson(value as JsonValue).value;
  const cut = cutStrings(masked);
  const text = JSON.stringify(cut);
  if (text === undefined || text.length <= EVIDENCE_TOTAL_MAX) return cut;
  return { truncated: true, preview: text.slice(0, EVIDENCE_STRING_MAX).toWellFormed() };
}

function cutStrings(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return value.length <= EVIDENCE_STRING_MAX
      ? value
      : `${value.slice(0, EVIDENCE_STRING_MAX).toWellFormed()}...[truncated]`;
  }
  if (Array.isArray(value)) return value.map(cutStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutStrings(v)]));
  }
  return value;
}
