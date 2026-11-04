import {
  type StoredEnvelope,
  storedEnvelopeSchema,
} from "../../../../../packages/protocol/src/index.ts";
import { PROJECT } from "../../../test/data/fake-engine.ts";

export const BASE = Date.parse("2026-10-30T12:00:00Z");

/** Hand-built recording: each spec becomes one stored envelope, ingest sequence 1..N, 1s apart. */
export function recording(
  specs: ReadonlyArray<{ type: string; agentId: string; payload: Record<string, unknown> }>,
  projectId: string = PROJECT,
): StoredEnvelope[] {
  return specs.map((spec, index) =>
    storedEnvelopeSchema.parse({
      ...spec,
      schemaVersion: 1,
      projectId,
      sourceId: "crew-bars-test",
      sourceEventId: `event-${index + 1}`,
      eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ingestSequence: index + 1,
      occurredAt: new Date(BASE + (index + 1) * 1000).toISOString(),
      receivedAt: new Date(BASE + (index + 1) * 1000).toISOString(),
      evidenceIds: [],
      provenance: "live",
      late: false,
    }),
  );
}

export const registered = (agentId: string, displayName: string, payload: object = {}) => ({
  type: "agent.registered",
  agentId,
  payload: { sourceAgentId: `source-${agentId}`, displayName, role: "dev", ...payload },
});
export const finished = (agentId: string) => ({
  type: "agent.finished",
  agentId,
  payload: { summary: "done" },
});
