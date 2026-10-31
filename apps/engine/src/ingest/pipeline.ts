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
  ): { response: EventBatchResponse; batch: CommittedBatch } {
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
    for (const projectId of [...touched].sort()) {
      const projectWork = work.get(projectId);
      // Only projects that accepted an event get a projection write and a broadcast head.
      if (projectWork && acceptedProjects.has(projectId)) {
        tx.writeProjection({
          projectId,
          reducerVersion: this.#reducer.version,
          head: projectWork.head,
          state: projectWork.state,
        });
        setOwn(acceptedHeads, projectId, projectWork.head);
      }
      setOwn(heads, projectId, tx.head(projectId) ?? 0);
    }
    return {
      response: { results, heads },
      batch: { events: accepted, heads: acceptedHeads },
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
    // Canonical JSON (and so the content hash) refuses lone surrogates; reject
    // the one event here rather than abort the whole batch at hashing.
    const badText = illFormedPath(event);
    if (badText !== undefined) {
      return {
        result: rejectedResult(raw, {
          code: badText.startsWith("payload.") ? "invalid_payload" : "invalid_envelope",
          path: badText,
          message: "Text must be well-formed Unicode (no lone surrogates)",
        }),
      };
    }
    const violation = producerPolicyViolation(event);
    if (violation) return { result: rejectedResult(raw, violation) };
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

  /** The project's state at its head: the stored projection if fresh, else a replay of its log. */
  #workFor(tx: StorageTransaction, projectId: string, work: Map<string, ProjectWork>): ProjectWork {
    const cached = work.get(projectId);
    if (cached) return cached;
    const head = tx.head(projectId) ?? 0;
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

/** Dotted path of the first string (or key) that is not well-formed UTF-16, if any. */
function illFormedPath(value: unknown, path = ""): string | undefined {
  if (typeof value === "string") return value.isWellFormed() ? undefined : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = illFormedPath(value[i], path === "" ? `${i}` : `${path}.${i}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const here = path === "" ? key : `${path}.${key}`;
      if (!key.isWellFormed()) return here;
      const found = illFormedPath(item, here);
      if (found !== undefined) return found;
    }
  }
  return undefined;
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
