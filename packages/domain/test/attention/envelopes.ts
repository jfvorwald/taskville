import {
  type EventType,
  type StoredEnvelopeOf,
  type StoredPayload,
  storedEnvelopeSchemas,
} from "@taskville/protocol";

// Builds valid stored envelopes for the attention reducer tests. Every envelope is parsed with the
// protocol's stored schema, so a test never feeds the reducer something the engine would not store.

export const BRIDGE = "taskville:bridge";
export const ENGINE = "taskville:engine";
export const TELEMETRY = "claude-code";

export interface EnvelopeFields {
  agentId?: string;
  sessionId?: string;
  sourceId?: string;
  occurredAt?: string;
  late?: boolean;
}

export type Emit = <T extends EventType>(
  type: T,
  payload: StoredPayload<T>,
  fields?: EnvelopeFields,
) => StoredEnvelopeOf<T>;

/** A deterministic stream: sequence numbers from 1, one second apart from 10:00:00Z. */
export function eventStream(projectId = "p1"): Emit {
  let seq = 0;
  return (type, payload, fields = {}) => {
    seq += 1;
    const at = new Date(Date.UTC(2026, 9, 30, 10, 0, seq)).toISOString();
    const raw = {
      schemaVersion: 1,
      projectId,
      sourceId: fields.sourceId ?? TELEMETRY,
      sourceEventId: `e-${seq}`,
      occurredAt: fields.occurredAt ?? at,
      type,
      payload,
      evidenceIds: [],
      provenance: "live",
      late: fields.late ?? false,
      eventId: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
      receivedAt: at,
      ingestSequence: seq,
      ...(fields.agentId === undefined ? {} : { agentId: fields.agentId }),
      ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
    };
    return storedEnvelopeSchemas[type].parse(raw) as StoredEnvelopeOf<typeof type>;
  };
}

export const reason = (text: string) => ({ text, masked: false, truncated: false });

/** Recursively freezes a value so a test fails if the reducer mutates its input. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
