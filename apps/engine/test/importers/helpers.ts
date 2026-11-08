import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputEventWire } from "@taskville/protocol";
import { afterEach, beforeEach } from "vitest";
import {
  type ImportBatch,
  type ImportContext,
  type ImportCounts,
  type Importer,
  ImportJobs,
  type ImportJobsOptions,
  ImportRefusal,
} from "../../src/importers/index.ts";
import { openStorage, type Storage } from "../../src/storage/index.ts";
import { addProject } from "../ingest/helpers.ts";

// Contract pinned for M8.06 (the surface M8.07 and M8.08 build on). Everything below is imported
// from `src/importers/index.ts` and `src/storage/index.ts`; see each test file's header.
//
//   storage.archives(): SqliteArchives
//     create({ id, projectId, kind, label, root, createdAt }): ArchiveRecord      (status "running")
//     get(id): ArchiveRecord | undefined
//     running(projectId): ArchiveRecord | undefined
//     complete(id, { events: ArchiveEventWrite[], counts, finishedAt }): ArchiveRecord
//     fail(id, { error: { code, message }, counts, finishedAt }): ArchiveRecord
//     cancel(id, { counts, finishedAt }): ArchiveRecord
//     failInterrupted(finishedAt): number                  (every row still "running" -> failed)
//     listDone(projectId): ArchiveRecord[]                 (status "done" only, newest first)
//     events(id, fromPosition, toPosition): StoredEnvelope[]   (inclusive range, position order)
//     eventAt(id, position): StoredEnvelope | undefined
//     positionAtOrBefore(id, at): number                   (greatest position with occurredAt <= at, 0 if none)
//
//   new ImportJobs({ storage, importers, evidence?, now?, maxEvents?, logger? })
//     start({ projectId, kind, root }): { importId, archiveId, status: "running" }   (synchronous; throws ImportRefusal)
//     status(importId): ImportStatus | undefined            (the GET /v1/imports/:id body)
//     settled(importId): Promise<ImportStatus>              (resolves when the job is finished)
//     close(): Promise<void>                                (engine shutdown: abort running jobs, await them)
//   registerImportRoutes(app, jobs)                         (POST /v1/imports, GET /v1/imports/:id)

export const PROJECT = "demo";
export const T0 = "2026-11-08T09:00:00.000Z";
export const fixedNow = () => new Date(Date.parse(T0));

/** A fresh database with project `demo` (one configured root: a real temporary directory). */
export function useImportsEnv(): () => ImportsEnv {
  let dir = "";
  let storage: Storage | undefined;
  let env: ImportsEnv | undefined;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "taskville-imports-")));
    const root = join(dir, "repo");
    mkdirSync(root);
    storage = openStorage(join(dir, "taskville.db"), { now: fixedNow });
    addProject(storage, PROJECT, [root]);
    env = { dir, root, storage, dbPath: join(dir, "taskville.db") };
  });
  afterEach(() => {
    try {
      storage?.close();
    } catch {
      // A test may already have closed it.
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    if (!env) throw new Error("imports env not ready");
    return env;
  };
}

export interface ImportsEnv {
  dir: string;
  /** The project's configured root (already a realpath). */
  root: string;
  storage: Storage;
  dbPath: string;
}

export function makeDir(env: ImportsEnv, name: string): string {
  const path = join(env.dir, name);
  mkdirSync(path);
  return path;
}

export function makeLink(env: ImportsEnv, name: string, target: string): string {
  const path = join(env.dir, name);
  symlinkSync(target, path);
  return path;
}

let counter = 0;

/** A valid `git.commit` import event. */
export function commitEvent(
  sourceEventId: string,
  occurredAt: string,
  extra: { sourceSequence?: number; overrides?: Record<string, unknown> } = {},
): InputEventWire {
  counter += 1;
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    sourceId: "git:test-repo",
    sourceEventId,
    occurredAt,
    ...(extra.sourceSequence === undefined ? {} : { sourceSequence: extra.sourceSequence }),
    type: "git.commit",
    payload: {
      repo: "test-repo",
      sha: counter.toString(16).padStart(40, "0"),
      parents: [],
      subject: `commit ${sourceEventId}`,
    },
    provenance: "imported",
    ...extra.overrides,
  } as InputEventWire;
}

/** An event the protocol parser rejects (`unknown_type`). */
export function unknownTypeEvent(sourceEventId: string): InputEventWire {
  return commitEvent(sourceEventId, "2026-11-01T10:00:00Z", {
    overrides: { type: "git.bogus" },
  });
}

/** An event the protocol parser rejects (`invalid_payload`: sha is not a hex object name). */
export function badPayloadEvent(sourceEventId: string): InputEventWire {
  return commitEvent(sourceEventId, "2026-11-01T10:00:00Z", {
    overrides: { payload: { repo: "r", sha: "not-a-sha", parents: [] } },
  });
}

export function zeroCounts(): ImportCounts {
  return { read: 0, imported: 0, skipped: 0, malformed: 0 };
}

/** A fake importer that yields the given batches and returns `final` (or counts derived from them). */
export function fakeImporter(
  batches: readonly ImportBatch[],
  options: {
    kind?: Importer["kind"];
    final?: ImportCounts;
    onRun?: (context: ImportContext) => void;
    onBatch?: (index: number) => void;
  } = {},
): Importer {
  const total = batches.reduce((n, b) => n + b.events.length, 0);
  return {
    kind: options.kind ?? "git",
    async *run(context) {
      options.onRun?.(context);
      let index = 0;
      for (const batch of batches) {
        options.onBatch?.(index);
        index += 1;
        yield batch;
      }
      return options.final ?? { read: total, imported: total, skipped: 0, malformed: 0 };
    },
  };
}

export interface Gate {
  importer: Importer;
  /** Resolves once the importer has yielded its first batch and reported progress. */
  started: Promise<void>;
  release(): void;
  contexts: ImportContext[];
}

/**
 * An importer that yields `first`, reports progress `{ read: 3, imported: 3, ... }`, then waits
 * until released or aborted. Released: it returns normally. Aborted: it returns without yielding.
 */
export function gatedImporter(first: ImportBatch, kind: Importer["kind"] = "git"): Gate {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const contexts: ImportContext[] = [];
  const importer: Importer = {
    kind,
    async *run(context) {
      contexts.push(context);
      yield first;
      context.progress({ read: 3, imported: 3, skipped: 0, malformed: 0 });
      markStarted();
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        context.signal.addEventListener("abort", () => resolve(), { once: true });
        void released.then(resolve);
      });
      return { read: first.events.length, imported: first.events.length, skipped: 0, malformed: 0 };
    },
  };
  return { importer, started, release, contexts };
}

export function makeJobs(
  env: ImportsEnv,
  importers: readonly Importer[],
  options: Partial<Omit<ImportJobsOptions, "storage" | "importers">> = {},
): ImportJobs {
  return new ImportJobs({ storage: env.storage, importers, now: fixedNow, ...options });
}

/** The refusal code `start` throws, or undefined when it does not throw. */
export function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof ImportRefusal) return error.code;
    throw error;
  }
  return undefined;
}
