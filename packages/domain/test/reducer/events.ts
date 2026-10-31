import {
  type EventType,
  type StoredEnvelopeOf,
  type StoredPayload,
  storedEnvelopeSchemas,
} from "@taskville/protocol";

// Builds valid stored envelopes for reducer tests. Every envelope is parsed with the protocol's
// stored schema, so a test can never feed the reducer something the engine would not store.

export interface EnvelopeFields {
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  sourceId?: string;
  occurredAt?: string;
  late?: boolean;
  evidenceIds?: string[];
  provenance?: "live" | "imported" | "demo";
  projectId?: string;
}

export type Emit = <T extends EventType>(
  type: T,
  payload: StoredPayload<T>,
  fields?: EnvelopeFields,
) => StoredEnvelopeOf<T>;

/** A deterministic event stream: sequence numbers from 1, one second apart, from 10:00:00Z. */
export function eventStream(projectId = "p1"): Emit {
  let seq = 0;
  return (type, payload, fields = {}) => {
    seq += 1;
    const seconds = seq % 60;
    const minutes = Math.floor(seq / 60) % 60;
    const hours = 10 + Math.floor(seq / 3600);
    const at = `2026-10-30T${pad(hours)}:${pad(minutes)}:${pad(seconds)}Z`;
    const raw = {
      schemaVersion: 1,
      projectId: fields.projectId ?? projectId,
      sourceId: fields.sourceId ?? "test",
      sourceEventId: `e-${seq}`,
      occurredAt: fields.occurredAt ?? at,
      type,
      payload,
      evidenceIds: fields.evidenceIds ?? [],
      provenance: fields.provenance ?? "live",
      late: fields.late ?? false,
      eventId: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
      receivedAt: at,
      ingestSequence: seq,
      ...(fields.agentId === undefined ? {} : { agentId: fields.agentId }),
      ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
      ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
    };
    return storedEnvelopeSchemas[type].parse(raw) as StoredEnvelopeOf<typeof type>;
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Recursively freezes a value so a test fails if the reducer mutates its input. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
