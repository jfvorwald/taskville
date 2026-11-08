import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import {
  parseInputEvent,
  producerPolicyViolation,
  type StoredEnvelope,
  storedEnvelopeSchemas,
} from "@taskville/protocol";
import type { Logger } from "pino";
import { normalizePayload } from "../ingest/normalize.ts";
import { textProblem } from "../ingest/text-check.ts";
import type { EvidenceSink } from "../sources/claude-code/index.ts";
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

/** Events per archive; past this the import still finishes, with the rest counted as skipped. */
export const MAX_ARCHIVE_EVENTS = 200_000;

export type ImportRefusalCode =
  | "unknown_import_kind"
  | "unknown_project"
  | "root_not_configured"
  | "import_running";

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

export interface ImportJobsOptions {
  storage: Storage;
  /** One importer per kind; a kind with none is refused with `unknown_import_kind`. */
  importers: readonly Importer[];
  /** Where tool bodies from batches go (the evidence store); redacted and bounded there. */
  evidence?: EvidenceSink;
  now?: () => Date;
  /** Events per archive. Default 200,000. */
  maxEvents?: number;
  logger?: Logger;
}

export interface ImportRequest {
  projectId: string;
  kind: string;
  root: string;
}

interface Job {
  controller: AbortController;
  /** The importer's latest progress report. */
  counts: ArchiveCounts;
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
  seen: Set<string>;
  skipped: number;
  malformed: number;
  byCode: Map<string, number>;
  truncated: boolean;
}

const ZERO_COUNTS: ArchiveCounts = { read: 0, imported: 0, skipped: 0, malformed: 0 };

const compare = (a: string | number | undefined, b: string | number | undefined): number => {
  const x = a ?? Number.NEGATIVE_INFINITY;
  const y = b ?? Number.NEGATIVE_INFINITY;
  return x < y ? -1 : x > y ? 1 : 0;
};

function realpathOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** The real path of `root` when it is one of `configured` (after realpath), else undefined. */
function configuredRoot(configured: readonly string[], root: string): string | undefined {
  if (!isAbsolute(root)) return undefined;
  const real = realpathOf(root);
  if (real === undefined) return undefined;
  return configured.some((candidate) => realpathOf(candidate) === real) ? real : undefined;
}

export class ImportJobs {
  readonly #storage: Storage;
  readonly #importers: Map<string, Importer>;
  readonly #evidence: EvidenceSink | undefined;
  readonly #now: () => Date;
  readonly #maxEvents: number;
  readonly #logger: Logger | undefined;
  readonly #jobs = new Map<string, Job>();
  #closed = false;

  constructor(options: ImportJobsOptions) {
    this.#storage = options.storage;
    this.#importers = new Map(options.importers.map((importer) => [importer.kind, importer]));
    this.#evidence = options.evidence;
    this.#now = options.now ?? (() => new Date());
    this.#maxEvents = options.maxEvents ?? MAX_ARCHIVE_EVENTS;
    this.#logger = options.logger;
    // An import left running belonged to an engine that died; it has no events and never will.
    const interrupted = this.#storage.archives().failInterrupted(this.#now().toISOString());
    if (interrupted > 0) this.#logger?.warn({ interrupted }, "interrupted imports marked failed");
  }

  /** Starts an import and returns at once; the job runs off the caller. Throws `ImportRefusal`. */
  start(request: ImportRequest): { importId: string; archiveId: string; status: "running" } {
    if (this.#closed) throw new Error("import jobs are closed");
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
    if (archives.running(project.id) !== undefined) {
      throw new ImportRefusal("import_running", "This project already has a running import");
    }
    const id = randomUUID();
    archives.create({
      id,
      projectId: project.id,
      kind: importer.kind,
      label: `${importer.kind}: ${basename(root)}`,
      root,
      createdAt: this.#now().toISOString(),
    });
    const job: Job = {
      controller: new AbortController(),
      counts: { ...ZERO_COUNTS },
      done: Promise.resolve({} as ImportStatus),
    };
    this.#jobs.set(id, job);
    job.done = this.#run(id, importer, project.id, root, job);
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

  /** Engine shutdown: aborts running jobs and waits for them to be marked cancelled. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.#jobs.values()].map((job) => job.done));
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
      seen: new Set(),
      skipped: 0,
      malformed: 0,
      byCode: new Map(),
      truncated: false,
    };
    try {
      const final = await this.#read(importer, projectId, root, job, tally);
      if (signal.aborted || final === undefined) {
        this.#storage.archives().cancel(id, { counts: job.counts, finishedAt: this.#finishedAt() });
      } else {
        this.#write(id, final, tally);
      }
    } catch (error) {
      this.#logger?.warn({ errName: (error as Error).name }, "import failed");
      const failure: ArchiveError =
        error instanceof WriteFailure
          ? { code: "write_failed", message: "The archive could not be written" }
          : { code: "importer_failed", message: "The importer failed" };
      try {
        if (signal.aborted) {
          this.#storage
            .archives()
            .cancel(id, { counts: job.counts, finishedAt: this.#finishedAt() });
        } else {
          this.#storage
            .archives()
            .fail(id, { error: failure, counts: job.counts, finishedAt: this.#finishedAt() });
        }
      } catch (inner) {
        this.#logger?.error({ errName: (inner as Error).name }, "import could not be recorded");
      }
    }
    return this.status(id) as ImportStatus;
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
        job.counts = { ...counts };
      },
    });
    for (;;) {
      const step = await generator.next();
      if (step.done) return signal.aborted ? undefined : step.value;
      if (signal.aborted) {
        await generator.return({ read: 0, imported: 0, skipped: 0, malformed: 0 });
        return undefined;
      }
      this.#take(projectId, step.value, receivedAt, tally);
    }
  }

  /** Validates a batch's events into the tally; evidence goes to the evidence store. */
  #take(projectId: string, batch: ImportBatch, receivedAt: string, tally: Tally): void {
    if (batch.evidence !== undefined && batch.evidence.length > 0 && this.#evidence) {
      try {
        this.#evidence.store(projectId, batch.evidence);
      } catch (error) {
        // Name only: the message can carry the body.
        this.#logger?.warn({ errName: (error as Error).name }, "import evidence not stored");
      }
    }
    for (const raw of batch.events) {
      const prepared = prepare(raw, projectId, receivedAt);
      if (!prepared.ok) {
        tally.malformed += 1;
        tally.byCode.set(prepared.code, (tally.byCode.get(prepared.code) ?? 0) + 1);
        continue;
      }
      const { envelope } = prepared.event;
      const key = `${envelope.sourceId}\u0000${envelope.sourceEventId}`;
      if (tally.seen.has(key)) {
        tally.skipped += 1;
        continue;
      }
      if (tally.kept.length >= this.#maxEvents) {
        tally.skipped += 1;
        tally.truncated = true;
        continue;
      }
      tally.seen.add(key);
      tally.kept.push(prepared.event);
    }
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
    };
    try {
      this.#storage.archives().complete(id, { events, counts, finishedAt: this.#finishedAt() });
    } catch (error) {
      this.#logger?.warn({ errName: (error as Error).name }, "archive write failed");
      throw new WriteFailure();
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

type PrepareResult = { ok: true; event: Prepared } | { ok: false; code: string };

/** The ingest checks for one imported event, up to its stored envelope (position set later). */
function prepare(raw: unknown, projectId: string, receivedAt: string): PrepareResult {
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
