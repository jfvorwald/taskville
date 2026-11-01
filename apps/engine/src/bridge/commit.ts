import { randomUUID } from "node:crypto";
import type { ProjectState } from "@taskville/domain/reducer";
import { parseInputEvent, type StoredEnvelope, storedEnvelopeSchemas } from "@taskville/protocol";
import type { Logger } from "pino";
import { domainReducer, normalizePayload } from "../ingest/index.ts";
import { textProblem } from "../ingest/text-check.ts";
import { clientContentHash, type ProjectionReducer, type Storage } from "../storage/index.ts";
import type { StreamHub } from "../stream/index.ts";

export interface EngineCommitOptions {
  storage: Storage;
  hub: StreamHub;
  now?: () => Date;
  newEventId?: () => string;
  reducer?: ProjectionReducer<ProjectState>;
  logger?: Logger;
}

/**
 * The bridge's trusted append. `IngestPipeline` refuses the reserved `taskville:` source and the
 * engine-only types by design (producer policy), so the bridge, which is engine code, commits
 * its own events here instead of weakening that policy. Everything else matches the pipeline:
 * the same input parse, text check, masking, stored-shape check, one transaction that appends,
 * applies the reducer, and writes the projection (the `expireOpenRequests` pattern), and a
 * broadcast to the stream hub only after COMMIT. The pipeline's projection cache is validated
 * against the stored row on every batch, so it re-reads what this writes.
 *
 * Returns the stored event, or undefined when the event was refused or is a duplicate of one
 * already stored (nothing is written then).
 */
export function commitEngineEvent(
  options: EngineCommitOptions,
  raw: Readonly<Record<string, unknown>>,
): StoredEnvelope | undefined {
  const parsed = parseInputEvent(raw);
  if (!parsed.ok) return undefined;
  const event = parsed.event;
  if (textProblem(event) !== undefined) return undefined;
  const reducer = options.reducer ?? domainReducer;
  const receivedAt = (options.now ?? (() => new Date()))().toISOString();
  const { hashed, stored: payload } = normalizePayload(event);
  const contentHash = clientContentHash({ ...event, payload: hashed });

  const stored = options.storage.transaction((tx): StoredEnvelope | undefined => {
    const head = tx.head(event.projectId);
    if (head === undefined) return undefined;
    if (tx.findEventBySourceKey(event.projectId, event.sourceId, event.sourceEventId)) {
      return undefined;
    }
    const checked = storedEnvelopeSchemas[event.type].safeParse({
      ...event,
      payload,
      eventId: (options.newEventId ?? randomUUID)(),
      receivedAt,
      ingestSequence: head + 1,
    });
    if (!checked.success) return undefined;
    const envelope = checked.data as StoredEnvelope;
    const projection = tx.projection<ProjectState>(event.projectId);
    const state =
      projection && projection.reducerVersion === reducer.version && projection.head === head
        ? projection.state
        : [...tx.events(event.projectId)].reduce(reducer.apply, reducer.initial(event.projectId));
    tx.appendEvent(envelope, contentHash);
    tx.writeProjection({
      projectId: event.projectId,
      reducerVersion: reducer.version,
      head: envelope.ingestSequence,
      state: reducer.apply(state, envelope),
    });
    return envelope;
  });
  if (stored !== undefined) {
    try {
      options.hub.publish({
        events: [stored],
        heads: { [stored.projectId]: stored.ingestSequence },
      });
    } catch (error) {
      options.logger?.error({ errName: (error as Error).name }, "broadcast hook failed");
    }
  }
  return stored;
}
