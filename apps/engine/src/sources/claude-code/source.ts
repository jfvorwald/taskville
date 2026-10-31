import { type EventBatchResponse, type IngestResult, parseInputEvent } from "@taskville/protocol";
import type { Logger } from "pino";
import { type IngestPipeline, normalizePayload } from "../../ingest/index.ts";
import { textProblem } from "../../ingest/text-check.ts";
import {
  clientContentHash,
  type StorageReads,
  type StoredEventRecord,
} from "../../storage/index.ts";
import { type ResolveOptions, resolveProjectId } from "./resolve-project.ts";

/**
 * The source ID the protocol names for Claude Code telemetry (events.md, input
 * event `sourceId`). Every event this source ingests carries it.
 */
export const CLAUDE_CODE_SOURCE_ID = "claude-code";

/** What the engine tells the pure mapper (M2.03, `@taskville/adapters/claude-code`). */
export interface MapContext {
  /** Engine-assigned from the hook's `cwd` (ARCHITECTURE.md 8.1). */
  projectId: string;
  /** The shim's UUID for this hook; the mapper derives each event's `sourceEventId` from it. */
  sourceEventId: string;
  /** Engine clock, ISO-8601. */
  receivedAt: string;
  /** True only for hooks replayed from the spool (M2.07). */
  late: boolean;
}

/** A tool call's raw input and output, for the evidence store (M2.06). Unmasked. */
export interface HookEvidence {
  toolCallId: string;
  input?: unknown;
  output?: unknown;
}

export interface MapResult {
  /** Protocol input events. They still go through every ingest check. */
  events: readonly unknown[];
  evidence?: readonly HookEvidence[];
  /** Set when the hook maps to nothing; the reason is not echoed to the caller. */
  ignored?: string;
}

/** The pure mapper's shape: `mapClaudeCodeHook` from `@taskville/adapters/claude-code` (#22). */
export type ClaudeCodeMapper = (payload: unknown, ctx: MapContext) => MapResult;

/**
 * Where tool-call bodies go (M2.06 builds the real store). The bodies are raw
 * agent output: the sink must redact before it writes anything. Called after
 * the events committed; a throw is logged and does not undo them.
 */
export interface EvidenceSink {
  store(projectId: string, evidence: readonly HookEvidence[]): void;
}

/** Until M2.06 lands, evidence is dropped. */
export const noopEvidenceSink: EvidenceSink = { store: () => {} };

export interface ClaudeCodeSourceOptions extends ResolveOptions {
  pipeline: IngestPipeline;
  /** Project registry (decision #110): read on every hook, so projects added at runtime route at once. */
  storage: Pick<StorageReads, "projects" | "findEventBySourceKey" | "head">;
  mapper: ClaudeCodeMapper;
  evidence?: EvidenceSink;
  now?: () => Date;
  logger?: Logger;
}

export interface HookInput {
  sourceEventId: string;
  /** The raw hook JSON, untrusted. */
  payload: Record<string, unknown>;
  /** Only the spool replay (M2.07) passes true; the HTTP route never does. */
  late?: boolean;
  /**
   * Only the spool replay (M2.07) passes it: the shim's `spooledAt`, so a late
   * event is dated when the hook ran, not when the engine restarted. The HTTP
   * route never does (its body allows no such key); the engine clock is used.
   */
  receivedAt?: string;
}

export interface HookIngestResponse {
  projectId: string;
  results: IngestResult[];
  heads: Record<string, number>;
  ignored?: true;
}

/**
 * The Claude Code telemetry source (ARCHITECTURE.md 8.1): resolve the project
 * from the hook's `cwd`, call the pure mapper, and ingest what it returns
 * through the M1 pipeline (validation, producer policy, masking, dedupe on
 * `sourceEventId`, sequencing), never around it. The engine, not the mapper,
 * decides `projectId`, `sourceId`, and `late` on every event.
 *
 * Two entry points use it: `POST /v1/sources/claude-code/hooks` (always
 * `late: false`) and the spool replay at engine start (M2.07, `late: true`).
 */
export class ClaudeCodeSource {
  readonly #options: ClaudeCodeSourceOptions;
  readonly #evidence: EvidenceSink;
  readonly #now: () => Date;

  constructor(options: ClaudeCodeSourceOptions) {
    this.#options = options;
    this.#evidence = options.evidence ?? noopEvidenceSink;
    this.#now = options.now ?? (() => new Date());
  }

  async ingestHook(input: HookInput): Promise<HookIngestResponse> {
    const late = input.late === true;
    // An inherited `cwd` (a `__proto__` key in the JSON) is not the hook's cwd.
    const cwd = Object.hasOwn(input.payload, "cwd") ? input.payload.cwd : undefined;
    const projectId = await resolveProjectId(cwd, this.#options.storage.projects(), this.#options);
    const ctx: MapContext = {
      projectId,
      sourceEventId: input.sourceEventId,
      receivedAt: input.receivedAt ?? this.#now().toISOString(),
      late,
    };
    const mapped = this.#options.mapper(input.payload, ctx);
    if (mapped.events.length === 0) {
      return { projectId, results: [], heads: {}, ...(mapped.ignored ? { ignored: true } : {}) };
    }
    const events = mapped.events.map((event) =>
      isPlainRecord(event) ? { ...event, projectId, sourceId: CLAUDE_CODE_SOURCE_ID, late } : event,
    );
    const { results, heads } = this.#ingestOnce(projectId, events);
    // Evidence only for a hook whose events are in the log (accepted now or before), never orphaned.
    const logged = results.some((r) => r.status === "accepted" || r.status === "duplicate");
    if (logged && mapped.evidence !== undefined && mapped.evidence.length > 0) {
      try {
        this.#evidence.store(projectId, mapped.evidence);
      } catch (error) {
        // Name only: the message can carry tool output.
        this.#options.logger?.error({ errName: (error as Error).name }, "evidence store failed");
      }
    }
    return { projectId, results, heads };
  }

  /**
   * For this source the shim's `sourceEventId` alone is the idempotency key. A
   * hook carries no timestamp, so the mapper's `occurredAt` is the engine clock,
   * and a spool replay sets `late`: both are in the pipeline's content hash, so
   * a retry or a live-then-spooled hook would be a `conflict`. An event whose
   * key is already in the project's log is compared with it on everything but
   * those two fields and reported as `duplicate` (with the original
   * acknowledgment) or `conflict` (ARCHITECTURE.md 7.2), and is not re-sent;
   * the rest go through the pipeline. The check and the ingest run in the same tick, with
   * no await between them, so no other request can interleave.
   */
  #ingestOnce(projectId: string, events: readonly unknown[]): EventBatchResponse {
    const known = new Map<number, IngestResult>();
    const fresh: unknown[] = [];
    for (const [index, event] of events.entries()) {
      const key = isPlainRecord(event) ? event.sourceEventId : undefined;
      const existing =
        typeof key === "string"
          ? this.#options.storage.findEventBySourceKey(projectId, CLAUDE_CODE_SOURCE_ID, key)
          : undefined;
      if (typeof key === "string" && existing !== undefined) {
        known.set(index, compareWithLogged(key, event, existing));
      } else {
        fresh.push(event);
      }
    }
    if (known.size === 0) return this.#options.pipeline.ingest(events);
    const ingested =
      fresh.length === 0 ? { results: [], heads: {} } : this.#options.pipeline.ingest(fresh);
    const results: IngestResult[] = [];
    let next = 0;
    for (const index of events.keys()) {
      const result = known.get(index) ?? ingested.results[next++];
      if (result !== undefined) results.push(result);
    }
    const head = this.#options.storage.head(projectId);
    const heads =
      Object.hasOwn(ingested.heads, projectId) || head === undefined
        ? ingested.heads
        : { ...ingested.heads, [projectId]: head };
    return { results, heads };
  }
}

/**
 * The pipeline's dedupe hash (ingest `#ingestOne`: parse, mask, then
 * `clientContentHash`) of `event` with the logged event's `occurredAt` and
 * `late` put in, so only those two transport fields are ignored. Equal to the
 * logged hash means the same content: `duplicate`. Anything else, including an
 * event that no longer parses, is a `conflict`.
 */
function compareWithLogged(
  sourceEventId: string,
  event: unknown,
  logged: StoredEventRecord,
): IngestResult {
  const parsed = parseInputEvent({
    ...(event as Record<string, unknown>),
    occurredAt: logged.envelope.occurredAt,
    late: logged.envelope.late,
  });
  // Text the pipeline would reject (a lone surrogate) cannot be hashed (L-31): it differs.
  if (parsed.ok && textProblem(parsed.event) === undefined) {
    const { hashed } = normalizePayload(parsed.event);
    const hash = clientContentHash({ ...parsed.event, payload: hashed });
    if (hash === logged.contentHash) {
      return {
        sourceEventId,
        status: "duplicate",
        ingestSequence: logged.ingestSequence,
        eventId: logged.eventId,
      };
    }
  }
  return { sourceEventId, status: "conflict", existingEventId: logged.eventId };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
