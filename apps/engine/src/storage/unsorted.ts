import { randomUUID } from "node:crypto";
import { hashCanonical } from "@taskville/domain/hash";
import type { StoredEnvelope } from "@taskville/protocol";
import type { Storage } from "./storage.ts";

export const UNSORTED_PROJECT_ID = "unsorted";
export const UNSORTED_PROJECT_NAME = "Unsorted";
/** Source ID for events the engine emits itself (reserved prefix `taskville:`). */
export const ENGINE_SOURCE_ID = "taskville:engine";

const ENGINE_ASSIGNED = new Set(["eventId", "receivedAt", "ingestSequence"]);

/**
 * Dedupe content hash (research R-6): SHA-256 of the canonical JSON of an
 * event's client-supplied fields, leaving out the engine-assigned ones.
 */
export function clientContentHash(event: Readonly<Record<string, unknown>>): string {
  return hashCanonical(
    Object.fromEntries(Object.entries(event).filter(([key]) => !ENGINE_ASSIGNED.has(key))),
  );
}

export interface EnsureUnsortedOptions {
  now?: () => Date;
  newEventId?: () => string;
}

/**
 * Creates the built-in Unsorted project (FR-011) with its `project.created`
 * event as sequence 1, in one transaction, if it does not exist yet. Returns
 * whether it was created. Its projection is left to the boot rebuild
 * (`rebuildStaleProjections`), which treats a missing projection as stale.
 */
export function ensureUnsortedProject(
  storage: Storage,
  options: EnsureUnsortedOptions = {},
): boolean {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const eventId = (options.newEventId ?? randomUUID)();
  return storage.transaction((tx) => {
    if (tx.project(UNSORTED_PROJECT_ID)) return false;
    tx.insertProject({
      id: UNSORTED_PROJECT_ID,
      name: UNSORTED_PROJECT_NAME,
      createdAt: now,
      roots: [],
      builtin: true,
    });
    const created: StoredEnvelope = {
      schemaVersion: 1,
      eventId,
      projectId: UNSORTED_PROJECT_ID,
      sourceId: ENGINE_SOURCE_ID,
      sourceEventId: `project.created:${UNSORTED_PROJECT_ID}`,
      occurredAt: now,
      receivedAt: now,
      ingestSequence: 1,
      type: "project.created",
      payload: { name: UNSORTED_PROJECT_NAME, roots: [], builtin: true },
      evidenceIds: [],
      provenance: "live",
      late: false,
    };
    tx.appendEvent(created, clientContentHash(created));
    return true;
  });
}
