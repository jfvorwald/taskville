import {
  type StoredEnvelope,
  storedEnvelopeSchemas,
} from "../../../../../../packages/protocol/src/index.ts";

// Real stored envelopes for the M5.04 tests. Not a test file.

export const PROJECT = "envelopes";
export const AT = "2026-11-03T12:00:00.000Z";

let seq = 0;

export function stored(
  type: StoredEnvelope["type"],
  agentId: string,
  payload: Record<string, unknown>,
  occurredAt: string = AT,
): StoredEnvelope {
  seq++;
  return storedEnvelopeSchemas[type].parse({
    schemaVersion: 1,
    projectId: PROJECT,
    sourceId: "claude-code",
    sourceEventId: `env-${seq}`,
    eventId: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
    type,
    payload,
    occurredAt,
    receivedAt: AT,
    ingestSequence: seq,
    evidenceIds: [],
    provenance: "live",
    late: false,
    agentId,
  }) as StoredEnvelope;
}

export const message = (
  from: string,
  to: string,
  summary?: string,
  occurredAt: string = AT,
): StoredEnvelope =>
  stored(
    "team.message",
    from,
    { to, kind: "message", ...(summary === undefined ? {} : { summary }) },
    occurredAt,
  );
