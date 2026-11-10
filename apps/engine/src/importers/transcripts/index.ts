import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { ToolEvidence } from "@taskville/adapters/claude-code";
import {
  createTranscriptMapper,
  transcriptSlug,
} from "@taskville/adapters/claude-code/transcripts";
import type { ImportBatch, ImportContext, ImportCounts, Importer } from "../types.ts";

// Transcript importer (M8.02, imports design "Transcripts"). Reads the Claude Code session
// transcripts of one configured root, `<config dir>/projects/<slug of root>/*.jsonl`, read-only.
// The config dir is CLAUDE_CONFIG_DIR or ~/.claude. Lines are streamed, mapped by the pure
// adapter mapper, and yielded in batches; the job runner stores them.

/** Lines mapped before a batch is yielded, which is also how often abort is checked. */
const BATCH_LINES = 500;
/** Events in a batch that trigger a flush, checked after each line. */
const BATCH_EVENTS = 1000;
/** Default bytes parsed before a batch is yielded, so a few huge lines do not hold the event loop. */
const DEFAULT_YIELD_BYTES = 4 * 1024 * 1024;
/**
 * Before the first session's cwd is validated nothing is yielded, so the only limit is this many
 * lines or bytes, whichever comes first. It bounds what is buffered for an unvalidated file.
 */
const ALLOWANCE_LINES = 5_000;
const ALLOWANCE_BYTES = 16 * 1024 * 1024;
/** Events buffered before validation; a few lines can map to many events. */
const ALLOWANCE_EVENTS = 10_000;

/** Why a file was skipped, reported through `onSkip`. */
export type TranscriptSkipReason = "outside-root" | "no-cwd-in-allowance";

/** Default cap on one line; a longer line is counted malformed and never buffered whole. */
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;
const FILE_ID_MAX = 100;

const configDir = (): string => {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(homedir(), ".claude");
};

async function transcriptFiles(root: string): Promise<string[]> {
  const dir = join(configDir(), "projects", transcriptSlug(root));
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

/** A line, or `overlong` for one past the cap (its content was dropped, not buffered). */
type RawLine = string | typeof OVERLONG;
const OVERLONG = Symbol("overlong");

/**
 * Opens a file without following a symlink, even one swapped in after listing: O_NOFOLLOW makes
 * the open fail, and the opened descriptor must be a regular file. O_NONBLOCK keeps a FIFO swapped
 * in after listing from blocking the open (it has no effect on regular files).
 */
async function openRegular(file: string): Promise<FileHandle | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    return undefined;
  }
  return handle;
}

/**
 * Lines of an open file, reading chunks and holding at most `maxLineBytes` of one line. Stops
 * (ending the sequence) as soon as `signal` aborts, checked per chunk even while discarding an
 * over-long line.
 */
async function* readLines(
  handle: FileHandle,
  maxLineBytes: number,
  signal: AbortSignal,
): AsyncGenerator<RawLine> {
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  let parts: Buffer[] = [];
  let size = 0;
  let over = false;
  const flush = (): RawLine => {
    const line = over ? OVERLONG : Buffer.concat(parts, size).toString("utf8");
    parts = [];
    size = 0;
    over = false;
    return typeof line === "string" && line.endsWith("\r") ? line.slice(0, -1) : line;
  };
  const add = (bytes: Buffer) => {
    if (over) return;
    size += bytes.length;
    if (size > maxLineBytes) {
      over = true;
      parts = [];
      size = 0;
      return;
    }
    parts.push(Buffer.from(bytes));
  };
  for (;;) {
    if (signal.aborted) return;
    const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK, null);
    if (bytesRead === 0) break;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1 || nl >= bytesRead) break;
      add(chunk.subarray(start, nl));
      yield flush();
      start = nl + 1;
    }
    add(chunk.subarray(start, bytesRead));
  }
  if (over || size > 0) yield flush();
}

/** True when `cwd` is the root or a directory inside it (separator-aware, no prefix matching). */
function isInside(root: string, cwd: string): boolean {
  if (!isAbsolute(cwd)) return false;
  const rel = relative(root, cwd);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A stable per-file id for `sourceEventId`: the basename, shortened with a hash if long. */
function fileIdOf(file: string): string {
  const name = basename(file, ".jsonl");
  if (name.length <= FILE_ID_MAX) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `${name.slice(0, FILE_ID_MAX - 13)}~${hash}`;
}

export function createTranscriptImporter(
  options: {
    maxLineBytes?: number;
    yieldBytes?: number;
    /** Called once per skipped file whose skip has a reason (a cwd outside the root, or none). */
    onSkip?: (skip: { reason: TranscriptSkipReason }) => void;
  } = {},
): Importer {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const yieldBytes = options.yieldBytes ?? DEFAULT_YIELD_BYTES;
  return {
    kind: "transcripts",
    async *run(context: ImportContext): AsyncGenerator<ImportBatch, ImportCounts, void> {
      const counts: ImportCounts = { read: 0, imported: 0, skipped: 0, malformed: 0 };
      const report = () => context.progress({ ...counts });
      if (context.signal.aborted) {
        report();
        return counts;
      }
      for (const file of await transcriptFiles(context.root)) {
        if (context.signal.aborted) break;
        // Slugs collide (`/w/my-app` and `/w/my/app`), so a file counts only if it started in
        // this root. One descriptor serves the whole import and the check runs on the lines
        // actually imported: the first cwd any line reports, and every session's cwd as the mapper reports it for the session.started
        // it emits, must be inside the root, and nothing is yielded before the first is checked, so
        // a file rewritten in place cannot slip other content in. A file with an outside cwd
        // is skipped (or, if part was already yielded, read no further); so is a file with no cwd
        // in the allowance, or a link or non-file.
        const handle = await openRegular(file);
        if (handle === undefined) {
          counts.skipped += 1;
          continue;
        }
        const before = { ...counts };
        // Counts as of the last yield; a mid-file rejection returns to them.
        let restore = before;
        let validated = false;
        let rejected: TranscriptSkipReason | undefined;
        const mapper = createTranscriptMapper({
          projectId: context.projectId,
          fileId: fileIdOf(file),
        });
        let batch: ImportBatch = { events: [] };
        let lines = 0;
        let bytes = 0;
        let lineNumber = 0;
        const take = (result: { events: ImportBatch["events"]; evidence?: ToolEvidence[] }) => {
          for (const event of result.events) batch.events.push(event);
          if (result.evidence !== undefined) {
            batch.evidence ??= [];
            for (const item of result.evidence) batch.evidence.push(item);
          }
          counts.imported += result.events.length;
        };
        let aborted = false;
        try {
          for await (const raw of readLines(handle, maxLineBytes, context.signal)) {
            lineNumber += 1;
            counts.read += 1;
            if (raw === OVERLONG) {
              counts.malformed += 1;
              bytes += maxLineBytes;
            } else {
              bytes += Buffer.byteLength(raw);
              const result = mapper.mapLine(raw, lineNumber);
              // The first cwd any line reports validates the file; every session's own cwd is
              // checked too. A session's cwd may change later, so other lines are not re-checked.
              const outside = (cwd: string | undefined) =>
                cwd !== undefined && !isInside(context.root, cwd);
              if (!validated && result.cwd !== undefined) {
                if (outside(result.cwd)) {
                  rejected = "outside-root";
                  break;
                }
                validated = true;
              }
              // The stored value is the cleaned one, so the raw cwd on that line must be inside too.
              const reportsSessionCwd =
                result.sessionCwd !== undefined || result.sessionFirstCwd !== undefined;
              if (
                outside(result.sessionCwd) ||
                outside(result.sessionFirstCwd) ||
                (reportsSessionCwd && outside(result.cwd))
              ) {
                rejected = "outside-root";
                break;
              }
              if (result.outcome === "skipped") counts.skipped += 1;
              if (result.outcome === "malformed") counts.malformed += 1;
              take(result);
            }
            lines += 1;
            // A real transcript shows its cwd within the first few lines, so a file that shows none
            // within the allowance is skipped. That bounds the buffering before validation.
            if (!validated) {
              if (
                lines >= ALLOWANCE_LINES ||
                bytes >= ALLOWANCE_BYTES ||
                batch.events.length >= ALLOWANCE_EVENTS
              ) {
                rejected = "no-cwd-in-allowance";
                break;
              }
              continue;
            }
            const full =
              lines >= BATCH_LINES || bytes >= yieldBytes || batch.events.length >= BATCH_EVENTS;
            if (full) {
              restore = { ...counts };
              report();
              yield batch;
              batch = { events: [] };
              lines = 0;
              bytes = 0;
              if (context.signal.aborted) {
                aborted = true;
                break;
              }
            }
          }
        } finally {
          await handle.close();
        }
        // A cancelled file is partial; stop here.
        if (aborted || context.signal.aborted) {
          // A file never validated yielded nothing; do not count its lines.
          if (!validated) Object.assign(counts, before);
          break;
        }
        if (rejected !== undefined || !validated) {
          // Forget the counts of what was not yielded (all of an unvalidated file) and skip it.
          Object.assign(counts, restore);
          counts.skipped += 1;
          options.onSkip?.({ reason: rejected ?? "no-cwd-in-allowance" });
          continue;
        }
        take(mapper.finish());
        report();
        yield batch;
      }
      report();
      return counts;
    },
  };
}
