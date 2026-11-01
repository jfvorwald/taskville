// A day-sized log for the timeline tests and the seek measurement (tests/perf/seek.ts).
// Pure: no vitest import, so a plain `node` script can use it too.
import type { StoredEnvelope } from "@taskville/protocol";
import {
  CALM,
  DEMO_EPOCH_MS,
  isoFromMs,
  LIVELY,
  type Pace,
  runOffline,
} from "../../../../packages/demo/src/index.ts";
import { domainReducer } from "../../src/ingest/index.ts";
import {
  clientContentHash,
  ENGINE_SOURCE_ID,
  rebuildProjection,
  type Storage,
} from "../../src/storage/index.ts";

export const DAY_PROJECT = "demo";
export const DAY_MS = 24 * 3_600_000;
/** The engine clock after the day is over, so history reads never depend on "now". */
export const AFTER_DAY = new Date(DEMO_EPOCH_MS + DAY_MS + 3_600_000);

export { CALM, LIVELY };

const cache = new Map<string, StoredEnvelope[]>();

/**
 * One simulated day of the seeded six-agent demo as stored events: `project.created` at sequence 1
 * (as `POST /v1/projects` writes it), then the demo events at sequence 2 and up. `receivedAt`
 * equals `occurredAt` and never decreases, so time and sequence agree. Calm is about 10,000
 * events, lively about 50,000.
 */
export function dayEvents(pace: Pace = CALM, projectId = DAY_PROJECT): StoredEnvelope[] {
  const key = `${pace.name}:${projectId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const run = runOffline({ seed: 42, pace, durationMs: DAY_MS, projectId });
  const start = isoFromMs(DEMO_EPOCH_MS);
  const created: StoredEnvelope = {
    schemaVersion: 1,
    eventId: "00000000-0000-4000-8000-000000000000",
    projectId,
    sourceId: ENGINE_SOURCE_ID,
    sourceEventId: `project.created:${projectId}`,
    occurredAt: start,
    receivedAt: start,
    ingestSequence: 1,
    type: "project.created",
    payload: { name: projectId, roots: [], builtin: false },
    evidenceIds: [],
    provenance: "live",
    late: false,
  };
  const events = [
    created,
    ...run.events.map((e) => ({ ...e, ingestSequence: e.ingestSequence + 1 })),
  ];
  cache.set(key, events);
  return events;
}

/** Writes `events` (sequence 1 upward, first one `project.created`) as a new project and rebuilds its projection. */
export function seedLog(storage: Storage, events: readonly StoredEnvelope[]): void {
  const first = events[0];
  if (!first) throw new Error("no events to seed");
  storage.transaction((tx) => {
    tx.insertProject({
      id: first.projectId,
      name: first.projectId,
      createdAt: first.occurredAt,
      roots: [],
      builtin: false,
    });
    for (const event of events) tx.appendEvent(event, clientContentHash(event));
  });
  rebuildProjection(storage, first.projectId, domainReducer);
}
