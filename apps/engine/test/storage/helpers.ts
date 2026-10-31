import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StoredEnvelope, storedEnvelopeSchema } from "@taskville/protocol";
import { afterEach, beforeEach } from "vitest";
import type { ProjectionReducer } from "../../src/storage/index.ts";

/** A fresh temporary directory per test, removed afterwards. */
export function useTempDir(prefix = "taskville-storage-"): () => string {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}

export const AT = "2026-10-30T12:00:00.000Z";

/** A stored `agent.connected` envelope, validated against the protocol schema. */
export function envelope(
  projectId: string,
  ingestSequence: number,
  overrides: Partial<Record<string, unknown>> = {},
): StoredEnvelope {
  return storedEnvelopeSchema.parse({
    schemaVersion: 1,
    eventId: randomUUID(),
    projectId,
    sourceId: "test-source",
    sourceEventId: `e-${ingestSequence}`,
    occurredAt: AT,
    receivedAt: AT,
    ingestSequence,
    agentId: `agent-${ingestSequence % 3}`,
    type: "agent.connected",
    payload: {},
    evidenceIds: [],
    provenance: "live",
    late: false,
    ...overrides,
  });
}

export const HASH_A = "a".repeat(64);

export interface StandInState {
  projectId: string;
  head: number;
  counts: Record<string, number>;
  agents: Record<string, number>;
  trail: string[];
}

/**
 * A small pure reducer standing in for the domain reducer (#9), which is not
 * merged yet. Order-sensitive (`trail`) so a replay in the wrong order hashes
 * differently.
 */
export function standInReducer(version = 1): ProjectionReducer<StandInState> {
  return {
    version,
    initial: (projectId) => ({ projectId, head: 0, counts: {}, agents: {}, trail: [] }),
    apply: (state, event) => {
      const agentId = "agentId" in event && event.agentId !== undefined ? event.agentId : "none";
      return {
        ...state,
        head: event.ingestSequence,
        counts: { ...state.counts, [event.type]: (state.counts[event.type] ?? 0) + 1 },
        agents: { ...state.agents, [agentId]: (state.agents[agentId] ?? 0) + 1 },
        trail: [...state.trail, `${event.ingestSequence}:${event.sourceEventId}`],
      };
    },
  };
}
