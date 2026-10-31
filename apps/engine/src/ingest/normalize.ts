import { type JsonPath, type JsonValue, redactJson } from "@taskville/adapters/redact";
import {
  type EventType,
  ID_MAX_LENGTH,
  INPUT_PREVIEW_MAX_CHARS,
  type InputEvent,
  REASON_MAX_CHARS,
} from "@taskville/protocol";

// Payload normalization before commit (contracts/events.md "Masking", FR-017,
// research R-13): every payload string except IDs, enums, and timestamps has
// control characters stripped, then secrets masked. The content hash is taken
// over that masked, untruncated form. Only then is `reason` cut to 280 code
// points and stored as { text, masked, truncated }.

/**
 * Top-level payload fields left as sent, per type, because their schema type is
 * an ID, an enum, or a timestamp. Everything else that is a string, at any
 * depth, is free text and is normalized. Nested values (for example inside
 * `command.requested` `payload`) are always normalized.
 */
const UNMASKED_FIELDS: Partial<Record<EventType, readonly string[]>> = {
  "agent.registered": ["sourceAgentId", "kind", "parentAgentId", "teamId"],
  "team.started": ["teamId", "leadAgentId"],
  "team.ended": ["teamId"],
  "task.created": ["relatedTaskIds"],
  "task.assigned": ["agentIds"],
  "task.status_changed": ["status"],
  "task.handoff": ["fromAgentId", "toAgentId"],
  "activity.started": ["activity"],
  "tool_call.started": ["toolCallId"],
  "tool_call.finished": ["toolCallId", "phase"],
  "request.opened": ["requestId", "kind", "expiresAt"],
  "request.resolved": ["requestId", "resolution"],
  "request.expired": ["requestId"],
  "command.requested": ["commandId", "commandType", "requestId", "idempotencyKey"],
  "command.delivered": ["commandId"],
  "command.succeeded": ["commandId"],
  "command.expired": ["commandId"],
  "command.unsupported": ["commandId"],
  "command.failed": ["commandId"],
  "git.commit": ["sha", "parents"],
  "git.ref_moved": ["from", "to"],
  "git.merge": ["sha", "parents"],
};

/** Payload fields with a length limit that masking could push past (a marker can be longer than the secret). */
const CAPPED_FIELDS: Readonly<Record<string, number>> = {
  inputPreview: INPUT_PREVIEW_MAX_CHARS,
  sourceValue: ID_MAX_LENGTH,
};

/**
 * Removes C0 and C1 control characters and DEL, keeping tab and line feed so
 * multi-line text (summaries, previews) keeps its shape. Carriage returns go.
 */
export function stripControlCharacters(text: string): string {
  let out = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const control =
      (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
    if (control) {
      out += text.slice(start, i);
      start = i + 1;
    }
  }
  return start === 0 ? text : out + text.slice(start);
}

/** The first `max` code points of `text`, so a surrogate pair is never split. */
function cutCodePoints(text: string, max: number): { text: string; cut: boolean } {
  let count = 0;
  for (let i = 0; i < text.length; ) {
    if (count === max) return { text: text.slice(0, i), cut: true };
    const code = text.codePointAt(i) ?? 0;
    i += code > 0xffff ? 2 : 1;
    count += 1;
  }
  return { text, cut: false };
}

function mapStrings(
  value: JsonValue,
  skip: (path: JsonPath) => boolean,
  fn: (text: string) => string,
  path: Array<string | number> = [],
): JsonValue {
  if (typeof value === "string") return skip(path) ? value : fn(value);
  if (Array.isArray(value)) return value.map((item, i) => mapStrings(item, skip, fn, [...path, i]));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      // defineProperty keeps a "__proto__" key an own property (M1.20 lesson).
      Object.defineProperty(out, key, {
        value: mapStrings(item, skip, fn, [...path, key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

export interface NormalizedPayload {
  /** Control characters stripped and secrets masked; `reason` still a string. Hashed for dedupe. */
  hashed: Record<string, unknown>;
  /** What is stored: `hashed` with `reason` as { text, masked, truncated } and capped fields cut. */
  stored: Record<string, unknown>;
}

export function normalizePayload(event: InputEvent): NormalizedPayload {
  const unmasked = new Set(UNMASKED_FIELDS[event.type] ?? []);
  const skip = (path: JsonPath) => typeof path[0] === "string" && unmasked.has(path[0]);
  const stripped = mapStrings(event.payload as JsonValue, skip, stripControlCharacters);
  const { value, masks } = redactJson(stripped, { skip });
  const hashed = value as Record<string, unknown>;

  const stored: Record<string, unknown> = { ...hashed };
  if (typeof hashed.reason === "string") {
    const { text, cut } = cutCodePoints(hashed.reason, REASON_MAX_CHARS);
    stored.reason = {
      text,
      masked: masks.some((mask) => mask.path.length === 1 && mask.path[0] === "reason"),
      truncated: cut,
    };
  }
  for (const [field, max] of Object.entries(CAPPED_FIELDS)) {
    const current = stored[field];
    if (typeof current === "string" && !unmasked.has(field)) {
      stored[field] = cutCodePoints(current, max).text;
    }
  }
  return { hashed, stored };
}
