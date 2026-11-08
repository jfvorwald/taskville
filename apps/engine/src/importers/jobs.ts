import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { ToolEvidence } from "@taskville/adapters/claude-code";
import {
  parseInputEvent,
  producerPolicyViolation,
  type StoredEnvelope,
  storedEnvelopeSchemas,
} from "@taskville/protocol";
import type { Logger } from "pino";
import { normalizePayload } from "../ingest/normalize.ts";
import { textProblem } from "../ingest/text-check.ts";
import {
  type ArchiveCounts,
  type ArchiveError,
  type ArchiveEventWrite,
  type ArchiveStatus,
  clientContentHash,
  type Storage,
} from "../storage/index.ts";
import type { ArchiveKind, ImportBatch, ImportCounts, Importer } from "./types.ts";

// The import job runner (ARCHITECTURE.md 7.3, 7.4; imports design, Storage and Imports API): runs
// an `Importer` off the request, validates and sorts what it yields, and writes one archive in one
// transaction at the end. Live events, projections and the live head are never touched.

/** Events per archive; past this the import stops and finishes `done` with `truncated: true`. */
export const MAX_ARCHIVE_EVENTS = 200_000;
/** Serialized size of one imported event. */
export const MAX_EVENT_BYTES = 64 * 1024;
/** Raw JSON size of one evidence item. */
export const MAX_EVIDENCE_ITEM_BYTES = 1024 * 1024;
/** Raw evidence an import may stage; items past it are dropped and counted. */
export const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
/** How long `close` waits for an importer that ignores its signal. */
export const CLOSE_TIMEOUT_MS = 5000;
const MAX_LABEL_LENGTH = 100;

export type ImportRefusalCode =
  | "unknown_import_kind"
  | "unknown_project"
  | "root_not_configured"
  | "import_running"
  | "engine_closing";

/** `start` refused the request; nothing was created. */
export class ImportRefusal extends Error {
  override name = "ImportRefusal";
  readonly code: ImportRefusalCode;
  constructor(code: ImportRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The `GET /v1/imports/:id` body. The import ID equals the archive ID. */
export interface ImportStatus {
  importId: string;
  archiveId: string;
  projectId: string;
  kind: ArchiveKind;
  status: ArchiveStatus;
  counts: ArchiveCounts;
  error?: ArchiveError;
  startedAt: string;
  finishedAt?: string;
}

/** Where an import's tool bodies go, scoped to its archive (the evidence store). */
export interface ArchiveEvidenceSink {
  store(projectId: string, evidence: readonly ToolEvidence[], archiveId?: string): void;
}

export interface ImportJobsOptions {
  storage: Storage;
  /** One importer per kind; a kind with none is refused with `unknown_import_kind`. */
  importers: readonly Importer[];
  /** Where tool bodies from batches go once the archive is written; redacted and bounded there. */
  evidence?: ArchiveEvidenceSink;
  now?: () => Date;
  /** Events per archive. Default 200,000. */
  maxEvents?: number;
  /** Serialized bytes of one event; over it the event is malformed `payload_too_large`. Default 64 KB. */
  maxEventBytes?: number;
  /** Raw JSON bytes of one evidence item; over it the item is dropped. Default 1 MiB. */
  maxEvidenceItemBytes?: number;
  /** Raw evidence bytes per import; items past it are dropped. Default 64 MiB. */
  maxEvidenceBytes?: number;
  /** `close` stops waiting for an importer after this long. Default 5 s. */
  closeTimeoutMs?: number;
  logger?: Logger;
}

export interface ImportRequest {
  projectId: string;
  kind: string;
  root: string;
}

interface Job {
  controller: AbortController;
  projectId: string;
  kind: ArchiveKind;
  startedAt: string;
  /** The importer's latest progress report, sanitized. */
  counts: ArchiveCounts;
  /** Set once the archive has been recorded (or released after a failed recording). */
  recorded: boolean;
  done: Promise<ImportStatus>;
}

/** An accepted event, ready to be positioned. */
interface Prepared {
  envelope: StoredEnvelope;
  contentHash: string;
  ms: number;
}

/** What the runner itself decided while reading an importer's batches. */
interface Tally {
  kept: Prepared[];
  /** Source key to content hash, to tell an identical repeat from a conflicting one. */
  seen: Map<string, string>;
  skipped: number;
  malformed: number;
  byCode: Map<string, number>;
  truncated: boolean;
  /** Events taken from the importer's batches so far. */
  consumed: number;
  /** Tool call IDs of the kept events. */
  toolCalls: Set<string>;
  /** Evidence held in memory until the archive is complete. */
  evidence: ToolEvidence[];
  evidenceBytes: number;
  evidenceDropped: number;
}

type Outcome = "cancel" | { fail: ArchiveError };

const ZERO_COUNTS: ArchiveCounts = { read: 0, imported: 0, skipped: 0, malformed: 0 };

const compare = (a: string | number | undefined, b: string | number | undefined): number => {
  const x = a ?? Number.NEGATIVE_INFINITY;
  const y = b ?? Number.NEGATIVE_INFINITY;
  return x < y ? -1 : x > y ? 1 : 0;
};

const wholeCount = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** The four totals, as whole numbers; anything else an importer sends is dropped. */
function sanitizeCounts(value: unknown): ImportCounts {
  const counts = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    read: wholeCount(counts.read),
    imported: wholeCount(counts.imported),
    skipped: wholeCount(counts.skipped),
    malformed: wholeCount(counts.malformed),
  };
}

/** The error's name for logs (never its message, which can carry source text). */
const errName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function realpathOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** The real path of `root` and the configured path it matched, or undefined when none matches. */
function configuredRoot(
  configured: readonly string[],
  root: string,
): { real: string; label: string } | undefined {
  if (!isAbsolute(root)) return undefined;
  const real = realpathOf(root);
  if (real === undefined) return undefined;
  const match = configured.find((candidate) => realpathOf(candidate) === real);
  return match === undefined ? undefined : { real, label: match };
}

/** `kind: name`, cut to 100 code units without splitting a surrogate pair. */
function labelFor(kind: string, configuredPath: string): string {
  return `${kind}: ${basename(configuredPath)}`
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/[\ud800-\udbff]$/, "");
}

export class ImportJobs {
  readonly #storage: Storage;
  readonly #importers: Map<string, Importer>;
  readonly #evidence: ArchiveEvidenceSink | undefined;
  readonly #now: () => Date;
  readonly #maxEvents: number;
  readonly #maxEventBytes: number;
  readonly #maxEvidenceItemBytes: number;
  readonly #maxEvidenceBytes: number;
  readonly #closeTimeoutMs: number;
  readonly #logger: Logger | undefined;
  readonly #jobs = new Map<string, Job>();
  /** Jobs that have started and not yet been recorded: one import runs engine-wide. */
  readonly #active = new Set<string>();
  #closed = false;

  constructor(options: ImportJobsOptions) {
    this.#storage = options.storage;
    this.#importers = new Map(options.importers.map((importer) => [importer.kind, importer]));
    this.#evidence = options.evidence;
    this.#now = options.now ?? (() => new Date());
    this.#maxEvents = options.maxEvents ?? MAX_ARCHIVE_EVENTS;
    this.#maxEventBytes = options.maxEventBytes ?? MAX_EVENT_BYTES;
    this.#maxEvidenceItemBytes = options.maxEvidenceItemBytes ?? MAX_EVIDENCE_ITEM_BYTES;
    this.#maxEvidenceBytes = options.maxEvidenceBytes ?? MAX_EVIDENCE_BYTES;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    this.#logger = options.logger;
    // An import left running belonged to an engine that died; it has no events and never will.
    const interrupted = this.#storage.archives().failInterrupted(this.#now().toISOString());
    if (interrupted > 0) this.#logger?.warn({ interrupted }, "interrupted imports marked failed");
  }

  /** Starts an import and returns at once; the job runs off the caller. Throws `ImportRefusal`. */
  start(request: ImportRequest): { importId: string; archiveId: string; status: "running" } {
    if (this.#closed) throw new ImportRefusal("engine_closing", "The engine is shutting down");
    const importer = this.#importers.get(request.kind);
    if (importer === undefined) {
      throw new ImportRefusal("unknown_import_kind", "No importer for this kind");
    }
    const project = this.#storage.project(request.projectId);
    if (project === undefined)
      throw new ImportRefusal("unknown_project", "No project with this ID");
    const root = configuredRoot(project.roots, request.root);
    if (root === undefined) {
      throw new ImportRefusal("root_not_configured", "Root is not one of the project's roots");
    }
    const archives = this.#storage.archives();
    if (this.#active.size > 0 || archives.running(project.id) !== undefined) {
      throw new ImportRefusal("import_running", "An import is already running");
    }
    const id = randomUUID();
    const startedAt = this.#now().toISOString();
    archives.create({
      id,
      projectId: project.id,
      kind: importer.kind,
      label: labelFor(importer.kind, root.label),
      root: root.real,
      createdAt: startedAt,
    });
    const job: Job = {
      controller: new AbortController(),
      projectId: project.id,
      kind: importer.kind,
      startedAt,
      counts: { ...ZERO_COUNTS },
      recorded: false,
      done: Promise.resolve({} as ImportStatus),
    };
    this.#jobs.set(id, job);
    this.#active.add(id);
    // The job promise never rejects: an unhandled rejection would take the engine down.
    job.done = this.#run(id, importer, project.id, root.real, job).catch((error: unknown) => {
      this.#logger?.error({ errName: errName(error) }, "import job crashed");
      this.#release(id, job);
      return this.#fallbackStatus(id, job);
    });
    return { importId: id, archiveId: id, status: "running" };
  }

  /** The import's status: live progress while running, the stored archive afterwards. */
  status(importId: string): ImportStatus | undefined {
    const archive = this.#storage.archives().get(importId);
    if (archive === undefined) return undefined;
    const job = this.#jobs.get(importId);
    return {
      importId: archive.id,
      archiveId: archive.id,
      projectId: archive.projectId,
      kind: archive.kind,
      status: archive.status,
      counts: archive.status === "running" && job ? job.counts : archive.counts,
      ...(archive.error === null ? {} : { error: archive.error }),
      startedAt: archive.createdAt,
      ...(archive.finishedAt === null ? {} : { finishedAt: archive.finishedAt }),
    };
  }

  /** Resolves with the final status once the import has finished. */
  settled(importId: string): Promise<ImportStatus> {
    const job = this.#jobs.get(importId);
    if (job) return job.done;
    const status = this.status(importId);
    return status ? Promise.resolve(status) : Promise.reject(new Error("unknown import"));
  }

  /**
   * Engine shutdown: aborts running jobs and waits for them to be marked cancelled, for at most
   * `closeTimeoutMs`; a job still running then is marked cancelled here.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs.values()) job.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#closeTimeoutMs);
    });
    const finished = Promise.allSettled([...this.#jobs.values()].map((job) => job.done));
    const result = await Promise.race([finished, timeout]);
    clearTimeout(timer);
    if (result !== "timeout") return;
    this.#logger?.warn("import did not stop in time; marking it cancelled");
    for (const [id, job] of this.#jobs) this.#record(id, job, "cancel");
  }

  async #run(
    id: string,
    importer: Importer,
    projectId: string,
    root: string,
    job: Job,
  ): Promise<ImportStatus> {
    // Let `start` return before the importer's first step.
    await Promise.resolve();
    const signal = job.controller.signal;
    const tally: Tally = {
      kept: [],
      seen: new Map(),
      skipped: 0,
      malformed: 0,
      byCode: new Map(),
      truncated: false,
      consumed: 0,
      toolCalls: new Set(),
      evidence: [],
      evidenceBytes: 0,
      evidenceDropped: 0,
    };
    let outcome: Outcome | undefined;
    try {
      const final = signal.aborted
        ? undefined
        : await this.#read(importer, projectId, root, job, tally);
      if (job.recorded) return this.#fallbackStatus(id, job);
      if (signal.aborted || final === undefined) {
        outcome = "cancel";
      } else {
        this.#write(id, final, tally);
        this.#release(id, job);
        this.#storeEvidence(projectId, id, tally);
      }
    } catch (error) {
      this.#logger?.warn({ errName: errName(error) }, "import failed");
      outcome = signal.aborted
        ? "cancel"
        : {
            fail:
              error instanceof WriteFailure
                ? { code: "write_failed", message: "The archive could not be written" }
                : { code: "importer_failed", message: "The importer failed" },
          };
    }
    if (outcome !== undefined) this.#record(id, job, outcome);
    return this.status(id) ?? this.#fallbackStatus(id, job);
  }

  /**
   * Marks the archive cancelled or failed, once. If the write throws, the other outcome is tried;
   * either way the job is released in memory so the engine is not left with a running import.
   */
  #record(id: string, job: Job, outcome: Outcome): void {
    if (job.recorded) return;
    this.#release(id, job);
    const archives = this.#storage.archives();
    const base = { counts: job.counts, finishedAt: this.#finishedAt() };
    const cancel = () => archives.cancel(id, base);
    const fail = (error: ArchiveError) => archives.fail(id, { error, ...base });
    const interrupted: ArchiveError = {
      code: "interrupted",
      message: "The engine stopped before the import finished",
    };
    try {
      if (outcome === "cancel") cancel();
      else fail(outcome.fail);
    } catch (error) {
      this.#logger?.error({ errName: errName(error) }, "import could not be recorded");
      try {
        if (outcome === "cancel") fail(interrupted);
        else cancel();
      } catch (inner) {
        this.#logger?.error({ errName: errName(inner) }, "import could not be recorded");
      }
    }
  }

  #release(id: string, job: Job): void {
    job.recorded = true;
    this.#active.delete(id);
  }

  /** A status built from what the job knows, for when the stored archive cannot be read. */
  #fallbackStatus(id: string, job: Job): ImportStatus {
    try {
      const stored = this.status(id);
      if (stored !== undefined) return stored;
    } catch {
      // The database may be closed; answer from memory.
    }
    return {
      importId: id,
      archiveId: id,
      projectId: job.projectId,
      kind: job.kind,
      status: "failed",
      counts: job.counts,
      error: { code: "importer_failed", message: "The importer failed" },
      startedAt: job.startedAt,
    };
  }

  /** Drives the importer to its end. Undefined when it was aborted before finishing. */
  async #read(
    importer: Importer,
    projectId: string,
    root: string,
    job: Job,
    tally: Tally,
  ): Promise<ImportCounts | undefined> {
    const signal = job.controller.signal;
    const receivedAt = this.#now().toISOString();
    const generator = importer.run({
      projectId,
      root,
      signal,
      progress: (counts) => {
        job.counts = sanitizeCounts(counts);
      },
    });
    for (;;) {
      const step = await generator.next();
      if (step.done) return signal.aborted ? undefined : sanitizeCounts(step.value);
      if (signal.aborted) {
        await generator.return(sanitizeCounts(undefined));
        return undefined;
      }
      this.#take(step.value, receivedAt, tally, projectId);
      if (tally.truncated) {
        // The cap is reached: stop the importer (its `finally` runs) instead of reading on.
        await generator.return(sanitizeCounts(undefined));
        // Its own count may lag (or be zero); at least the events consumed were read.
        const own = sanitizeCounts(job.counts);
        return { ...own, read: Math.max(own.read, tally.consumed) };
      }
      // Keep the engine's other work (requests, timers) moving between batches.
      await yieldToEventLoop();
    }
  }

  /** Validates a batch's events into the tally, then stages the evidence of the kept ones. */
  #take(batch: ImportBatch, receivedAt: string, tally: Tally, projectId: string): void {
    for (const raw of batch.events) {
      tally.consumed += 1;
      const prepared = prepare(raw, projectId, receivedAt, this.#maxEventBytes);
      if (!prepared.ok) {
        reject(tally, prepared.code);
        continue;
      }
      const { envelope } = prepared.event;
      const key = `${envelope.sourceId}\u0000${envelope.sourceEventId}`;
      const earlier = tally.seen.get(key);
      if (earlier !== undefined) {
        if (earlier === prepared.event.contentHash) tally.skipped += 1;
        else reject(tally, "conflict");
        continue;
      }
      if (tally.kept.length >= this.#maxEvents) {
        tally.skipped += 1;
        tally.truncated = true;
        continue;
      }
      tally.seen.set(key, prepared.event.contentHash);
      tally.kept.push(prepared.event);
      const toolCallId = (envelope.payload as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId === "string") tally.toolCalls.add(toolCallId);
    }
    for (const item of batch.evidence ?? []) this.#stage(item, tally);
  }

  /** Holds one evidence item in memory when a kept event refers to it and it fits the limits. */
  #stage(item: ToolEvidence, tally: Tally): void {
    if (!this.#evidence) return;
    const bytes = rawBytes(item);
    const linked = typeof item?.toolCallId === "string" && tally.toolCalls.has(item.toolCallId);
    if (
      !linked ||
      bytes === undefined ||
      bytes > this.#maxEvidenceItemBytes ||
      tally.evidenceBytes + bytes > this.#maxEvidenceBytes
    ) {
      tally.evidenceDropped += 1;
      return;
    }
    tally.evidenceBytes += bytes;
    tally.evidence.push(item);
  }

  /** Sorts, positions, and writes the archive in one transaction. */
  #write(id: string, final: ImportCounts, tally: Tally): void {
    const sorted = [...tally.kept].sort(
      (a, b) =>
        compare(a.ms, b.ms) ||
        compare(a.envelope.sourceSequence, b.envelope.sourceSequence) ||
        compare(a.envelope.sourceEventId, b.envelope.sourceEventId),
    );
    const events: ArchiveEventWrite[] = sorted.map((event, index) => ({
      contentHash: event.contentHash,
      envelope: { ...event.envelope, ingestSequence: index + 1 },
    }));
    const counts: ArchiveCounts = {
      read: final.read,
      imported: events.length,
      skipped: final.skipped + tally.skipped,
      malformed: final.malformed + tally.malformed,
      ...(tally.malformed > 0 ? { malformedByCode: Object.fromEntries(tally.byCode) } : {}),
      ...(tally.truncated ? { truncated: true } : {}),
      ...(tally.evidenceDropped > 0 ? { evidenceDropped: tally.evidenceDropped } : {}),
    };
    try {
      this.#storage.archives().complete(id, { events, counts, finishedAt: this.#finishedAt() });
    } catch (error) {
      this.#logger?.warn({ errName: errName(error) }, "archive write failed");
      throw new WriteFailure();
    }
  }

  /** After the archive is complete: the staged evidence, scoped to the archive. */
  #storeEvidence(projectId: string, archiveId: string, tally: Tally): void {
    if (!this.#evidence || tally.evidence.length === 0) return;
    try {
      this.#evidence.store(projectId, tally.evidence, archiveId);
    } catch (error) {
      // Name only: the message can carry the body.
      this.#logger?.warn({ errName: errName(error) }, "import evidence not stored");
    }
  }

  #finishedAt(): string {
    return this.#now().toISOString();
  }
}

/** The archive transaction failed; the archive is left without events. */
class WriteFailure extends Error {
  override name = "WriteFailure";
}

function reject(tally: Tally, code: string): void {
  tally.malformed += 1;
  tally.byCode.set(code, (tally.byCode.get(code) ?? 0) + 1);
}

/** Bytes of the JSON form of a value, or undefined when it has none. */
function rawBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : Buffer.byteLength(json);
  } catch {
    return undefined;
  }
}

type PrepareResult = { ok: true; event: Prepared } | { ok: false; code: string };

/** The ingest checks for one imported event, up to its stored envelope (position set later). */
function prepare(
  raw: unknown,
  projectId: string,
  receivedAt: string,
  maxEventBytes: number,
): PrepareResult {
  const size = rawBytes(raw);
  if (size === undefined) return { ok: false, code: "invalid_envelope" };
  if (size > maxEventBytes) return { ok: false, code: "payload_too_large" };
  const parsed = parseInputEvent(raw);
  if (!parsed.ok) return { ok: false, code: parsed.error.code };
  const event = parsed.event;
  const violation = producerPolicyViolation(event);
  if (violation) return { ok: false, code: violation.code };
  if (event.provenance !== "imported") return { ok: false, code: "provenance_mismatch" };
  if (event.projectId !== projectId) return { ok: false, code: "invalid_envelope" };
  const badText = textProblem(event);
  if (badText) return { ok: false, code: badText.code };

  const { hashed, stored } = normalizePayload(event);
  const checked = storedEnvelopeSchemas[event.type].safeParse({
    ...event,
    payload: stored,
    eventId: randomUUID(),
    receivedAt,
    ingestSequence: 1,
  });
  if (!checked.success) {
    const path = checked.error.issues[0]?.path.map(String).join(".") ?? "";
    return { ok: false, code: path.startsWith("payload") ? "invalid_payload" : "invalid_envelope" };
  }
  const envelope = checked.data as StoredEnvelope;
  return {
    ok: true,
    event: {
      envelope,
      contentHash: clientContentHash({ ...event, payload: hashed }),
      ms: Date.parse(envelope.occurredAt),
    },
  };
}
