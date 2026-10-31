import { randomUUID } from "node:crypto";
import {
  initialState,
  type ProjectState,
  REDUCER_VERSION,
  reduce,
} from "@taskville/domain/reducer";
import {
  type EventBatchResponse,
  type IngestError,
  type IngestResult,
  parseInputEvent,
  producerPolicyViolation,
  rejectedResult,
  type StoredEnvelope,
  storedEnvelopeSchemas,
} from "@taskville/protocol";
import type { Logger } from "pino";
import {
  clientContentHash,
  type ProjectionReducer,
  type Storage,
  type StorageTransaction,
} from "../storage/index.ts";
import { normalizePayload } from "./normalize.ts";
import { textProblem } from "./text-check.ts";

/** The domain reducer in the shape storage's rebuild and this pipeline take. */
export const domainReducer: ProjectionReducer<ProjectState> = {
  version: REDUCER_VERSION,
  initial: initialState,
  apply: reduce,
};

/** What a committed batch hands to the broadcast hook (the SSE hub, #15). */
export interface CommittedBatch {
  /** Accepted envelopes, in ingest order per project. Duplicates and conflicts are not repeated. */
  events: StoredEnvelope[];
  /** Head of every project that accepted at least one event. */
  heads: Record<string, number>;
}

export interface IngestOptions {
  storage: Storage;
  /** Engine clock for `receivedAt`. */
  now?: () => Date;
  newEventId?: () => string;
  /** Defaults to the domain reducer; a parameter so tests can inject failures. */
  reducer?: ProjectionReducer<ProjectState>;
  /** Called once per batch that accepted events, only after COMMIT. Errors are logged, not thrown. */
  onCommit?: (batch: CommittedBatch) => void;
  logger?: Logger;
}

interface ProjectWork {
  state: ProjectState;
  head: number;
  /** Set when this batch wrote the projection. */
  stateHash?: string;
}

/** A project's state as last committed by this pipeline, with the stored row it matches. */
interface CachedProjection {
  state: ProjectState;
  head: number;
  reducerVersion: number;
  stateHash: string;
}

/**
 * The ingest pipeline (ARCHITECTURE.md 7.2, research R-5). Each batch runs in
 * one BEGIN IMMEDIATE transaction: validate, apply producer policy, check the
 * project, normalize (strip, mask), dedupe on (project, source, sourceEventId),
 * assign `head + 1`, append, apply the reducer, then write every touched
 * projection. Only after COMMIT is anything returned or broadcast. An
 * unexpected error rolls the whole batch back and is thrown.
 */
export class IngestPipeline {
  readonly #storage: Storage;
  readonly #now: () => Date;
  readonly #newEventId: () => string;
  readonly #reducer: ProjectionReducer<ProjectState>;
  readonly #onCommit: ((batch: CommittedBatch) => void) | undefined;
  readonly #logger: Logger | undefined;
  /**
   * Parsed projections between batches (#166), so a batch does not read and parse `state_json`.
   * Updated only after COMMIT. Used only while the stored row still has the same head, reducer
   * version, and stateHash, so another connection's writes (events, a rebuild) are re-read from
   * disk. Relies on the reducer being pure (constitution III): states are never mutated.
   */
  readonly #cache = new Map<string, CachedProjection>();

  constructor(options: IngestOptions) {
    this.#storage = options.storage;
    this.#now = options.now ?? (() => new Date());
    this.#newEventId = options.newEventId ?? randomUUID;
    this.#reducer = options.reducer ?? domainReducer;
    this.#onCommit = options.onCommit;
    this.#logger = options.logger;
  }

  ingest(rawEvents: readonly unknown[]): EventBatchResponse {
    const committed = this.#storage.transaction((tx) => this.#ingestInTransaction(tx, rawEvents));
    for (const [projectId, written] of committed.written) this.#cache.set(projectId, written);
    if (committed.batch.events.length > 0 && this.#onCommit) {
      try {
        this.#onCommit(committed.batch);
      } catch (error) {
        this.#logger?.error({ errName: (error as Error).name }, "broadcast hook failed");
      }
    }
    return committed.response;
  }

  #ingestInTransaction(
    tx: StorageTransaction,
    rawEvents: readonly unknown[],
  ): {
    response: EventBatchResponse;
    batch: CommittedBatch;
    written: Map<string, CachedProjection>;
  } {
    const receivedAt = this.#now().toISOString();
    const work = new Map<string, ProjectWork>();
    const touched = new Set<string>();
    const accepted: StoredEnvelope[] = [];
    const results: IngestResult[] = [];

    for (const raw of rawEvents) {
      const outcome = this.#ingestOne(tx, raw, receivedAt, work);
      results.push(outcome.result);
      if (outcome.projectId !== undefined) touched.add(outcome.projectId);
      if (outcome.stored) accepted.push(outcome.stored);
    }

    const acceptedProjects = new Set(accepted.map((event) => event.projectId));
    const heads: Record<string, number> = {};
    const acceptedHeads: Record<string, number> = {};
    const written = new Map<string, CachedProjection>();
    for (const projectId of [...touched].sort()) {
      const projectWork = work.get(projectId);
      // Only projects that accepted an event get a projection write and a broadcast head.
      if (projectWork && acceptedProjects.has(projectId)) {
        const hash = tx.writeProjection({
          projectId,
          reducerVersion: this.#reducer.version,
          head: projectWork.head,
          state: projectWork.state,
        });
        written.set(projectId, {
          state: projectWork.state,
          head: projectWork.head,
          reducerVersion: this.#reducer.version,
          stateHash: hash,
        });
        setOwn(acceptedHeads, projectId, projectWork.head);
      }
      setOwn(heads, projectId, tx.head(projectId) ?? 0);
    }
    return {
      response: { results, heads },
      batch: { events: accepted, heads: acceptedHeads },
      written,
    };
  }

  #ingestOne(
    tx: StorageTransaction,
    raw: unknown,
    receivedAt: string,
    work: Map<string, ProjectWork>,
  ): { result: IngestResult; projectId?: string; stored?: StoredEnvelope } {
    const parsed = parseInputEvent(raw);
    if (!parsed.ok) return { result: rejectedResult(raw, parsed.error) };
    const event = parsed.event;
    // Producer policy first: it rejects engine-only types such as command.requested,
    // whose free-form payload is the only place unbounded nesting can reach.
    const violation = producerPolicyViolation(event);
    if (violation) return { result: rejectedResult(raw, violation) };
    const badText = textProblem(event);
    if (badText) return { result: rejectedResult(raw, badText) };
    if (tx.head(event.projectId) === undefined) {
      return {
        result: rejectedResult(raw, {
          code: "unknown_project",
          path: "projectId",
          message: "No project with this ID; add it with `taskville project add`",
        }),
      };
    }

    const { hashed, stored: storedPayload } = normalizePayload(event);
    const contentHash = clientContentHash({ ...event, payload: hashed });
    const projectId = event.projectId;

    const existing = tx.findEventBySourceKey(projectId, event.sourceId, event.sourceEventId);
    if (existing) {
      const result: IngestResult =
        existing.contentHash === contentHash
          ? {
              sourceEventId: event.sourceEventId,
              status: "duplicate",
              ingestSequence: existing.ingestSequence,
              eventId: existing.eventId,
            }
          : {
              sourceEventId: event.sourceEventId,
              status: "conflict",
              existingEventId: existing.eventId,
            };
      return { result, projectId };
    }

    const projectWork = this.#workFor(tx, projectId, work);
    const candidate = {
      ...event,
      payload: storedPayload,
      eventId: this.#newEventId(),
      receivedAt,
      ingestSequence: projectWork.head + 1,
    };
    const checked = storedEnvelopeSchemas[event.type].safeParse(candidate);
    if (!checked.success) {
      return { result: rejectedResult(raw, storedShapeError(checked.error.issues[0])), projectId };
    }
    const stored = checked.data as StoredEnvelope;
    tx.appendEvent(stored, contentHash);
    projectWork.state = this.#reducer.apply(projectWork.state, stored);
    projectWork.head = stored.ingestSequence;
    return {
      result: {
        sourceEventId: event.sourceEventId,
        status: "accepted",
        ingestSequence: stored.ingestSequence,
        eventId: stored.eventId,
      },
      projectId,
      stored,
    };
  }

  /**
   * The project's state at its head: this pipeline's cached state if the stored row is still the
   * one it wrote, else the stored projection if fresh, else a replay of its log.
   */
  #workFor(tx: StorageTransaction, projectId: string, work: Map<string, ProjectWork>): ProjectWork {
    const inBatch = work.get(projectId);
    if (inBatch) return inBatch;
    const head = tx.head(projectId) ?? 0;
    const cached = this.#cache.get(projectId);
    if (cached && cached.head === head && cached.reducerVersion === this.#reducer.version) {
      const meta = tx.projectionMeta(projectId);
      if (
        meta?.head === head &&
        meta.reducerVersion === cached.reducerVersion &&
        meta.stateHash === cached.stateHash
      ) {
        const fresh = { state: cached.state, head };
        work.set(projectId, fresh);
        return fresh;
      }
    }
    this.#cache.delete(projectId);
    const projection = tx.projection<ProjectState>(projectId);
    let state: ProjectState;
    if (
      projection &&
      projection.reducerVersion === this.#reducer.version &&
      projection.head === head
    ) {
      state = projection.state;
    } else {
      state = this.#reducer.initial(projectId);
      for (const event of tx.events(projectId)) state = this.#reducer.apply(state, event);
    }
    const fresh = { state, head };
    work.set(projectId, fresh);
    return fresh;
  }
}

/**
 * A stored envelope that fails its schema after normalization: text that was
 * only control characters, for example. Reported as the payload field at fault.
 */
function storedShapeError(
  issue: { path: PropertyKey[]; message: string } | undefined,
): IngestError {
  const path = issue?.path.map(String).join(".");
  const inPayload = path?.startsWith("payload") ?? false;
  return {
    code: inPayload ? "invalid_payload" : "invalid_envelope",
    ...(path ? { path } : {}),
    message: `${issue?.message ?? "Invalid event"} (after removing control characters and masking secrets)`,
  };
}

/** Sets an own property, so a project ID such as "__proto__" is kept rather than changing the prototype. */
function setOwn(record: Record<string, number>, key: string, value: number): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
