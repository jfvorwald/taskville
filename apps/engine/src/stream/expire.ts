import { randomUUID } from "node:crypto";
import type { ProjectState } from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import {
  clientContentHash,
  ENGINE_SOURCE_ID,
  type ProjectionReducer,
  type Storage,
} from "../storage/index.ts";

export interface ExpiredRequest {
  projectId: string;
  requestId: string;
}

/**
 * Engine start rule (ARCHITECTURE.md 6, data-model.md): a request still `open`
 * lost its hook connection with the old process, so each one gets a
 * `request.expired` event from `taskville:engine`. One transaction per project
 * appends the events, applies them, and writes the projection. Run after the
 * stale-projection rebuild and before the server listens, so no subscriber
 * can miss them. A request expires once; a later boot finds nothing open.
 */
export function expireOpenRequests(
  storage: Storage,
  reducer: ProjectionReducer<ProjectState>,
  options: { now?: () => Date; newEventId?: () => string } = {},
): ExpiredRequest[] {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const newEventId = options.newEventId ?? randomUUID;
  const expired: ExpiredRequest[] = [];
  for (const project of storage.projects()) {
    storage.transaction((tx) => {
      const head = tx.head(project.id) ?? 0;
      const stored = tx.projection<ProjectState>(project.id);
      let state =
        stored && stored.reducerVersion === reducer.version && stored.head === head
          ? stored.state
          : [...tx.events(project.id)].reduce(reducer.apply, reducer.initial(project.id));
      const open = Object.values(state.requests)
        .filter((request) => request.state === "open")
        .map((request) => request.id)
        .sort();
      if (open.length === 0) return;
      let sequence = head;
      for (const requestId of open) {
        sequence += 1;
        const event: StoredEnvelope = {
          schemaVersion: 1,
          eventId: newEventId(),
          projectId: project.id,
          sourceId: ENGINE_SOURCE_ID,
          sourceEventId: `request.expired:${requestId}`,
          occurredAt: now,
          receivedAt: now,
          ingestSequence: sequence,
          type: "request.expired",
          payload: { requestId },
          evidenceIds: [],
          provenance: "live",
          late: false,
        };
        tx.appendEvent(event, clientContentHash(event));
        state = reducer.apply(state, event);
        expired.push({ projectId: project.id, requestId });
      }
      tx.writeProjection({
        projectId: project.id,
        reducerVersion: reducer.version,
        head: sequence,
        state,
      });
    });
  }
  return expired;
}
