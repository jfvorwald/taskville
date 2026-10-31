// Spool ingest on engine start (ARCHITECTURE.md 8.1, M2.07). The telemetry
// shim (apps/cli/hooks/claude-code-shim.sh; its header is the format contract)
// appends hooks it could not post to `$TASKVILLE_HOME/spool`. On start the
// engine replays them through `ClaudeCodeSource.ingestHook` with `late: true`,
// dated at the shim's `spooledAt`, so they update history and agent records
// but never open a needs-you state.
//
// Crash safety: the main file is renamed aside under the shim's lock before it
// is read, so shim appends during replay go to a fresh main file and are never
// lost; a file is deleted only after every hook read from it committed. A crash
// at any point leaves the file for the next start, where the shim's
// `sourceEventId` makes every already-committed hook a duplicate.

import { randomUUID } from "node:crypto";
import {
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { compareTimestamps } from "@taskville/domain/reducer";
import { idSchema, timestampSchema } from "@taskville/protocol";
import type { Logger } from "pino";
import { MAX_HOOK_BODY_BYTES, MAX_HOOK_SOURCE_EVENT_ID } from "./route.ts";
import type { ClaudeCodeSource } from "./source.ts";

/** The shim's main spool file inside the spool directory. */
export const SPOOL_FILE = "claude-code.jsonl";
const LOCK = "claude-code.lock";
const BREAKER = `${LOCK}.break`;
/** Files to replay: per-event files `claude-code.<uuid>.jsonl` and claimed `claude-code.replay-<uuid>.jsonl`. */
const SPOOL_NAME = /^claude-code\.[A-Za-z0-9-]+\.jsonl$/;
/** Shim temporaries and set-aside locks. Never read; removed once stale. */
const TEMP_PREFIX = ".claude-code.";

/** The shim never writes a line longer than its cap plus the wrapper; anything longer is junk. */
export const MAX_SPOOL_LINE_BYTES = MAX_HOOK_BODY_BYTES + 64 * 1024;
/**
 * One run replays at most this many hooks ... Measured at about 1.35 ms per hook
 * (10,000 PreToolUse/PostToolUse hooks in 13.4 s, real mapper and pipeline, on
 * the development Mac), so a run before listen adds about 3 s at most.
 */
export const DEFAULT_MAX_HOOKS = 2000;
/** ... or reads this many bytes, whichever comes first; the rest waits for the next run. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** How long to wait for a live shim to release the lock before leaving the main file. */
export const DEFAULT_LOCK_WAIT_MS = 2000;
/** A lock without a PID, a break lock, or a temporary older than this was left by a killed shim. */
export const STALE_MS = 60_000;

const CHUNK = 64 * 1024;
const NAP_MS = 50;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const LINE_KEYS: ReadonlySet<string> = new Set([
  "payload",
  "sourceEventId",
  "spooledAt",
  "payloadBytesAtLeast",
]);

export interface SpoolReplayOptions {
  /** `$TASKVILLE_HOME/spool` (config `homePaths(home).spoolDir`). */
  spoolDir: string;
  source: Pick<ClaudeCodeSource, "ingestHook">;
  logger?: Logger | undefined;
  /** Wall clock in ms, for stale-lock and temporary ages (file mtimes are wall time). */
  now?: () => number;
  maxHooks?: number;
  maxBytes?: number;
  lockWaitMs?: number;
}

export interface SpoolReplayReport {
  /** What happened to `claude-code.jsonl`: none there, renamed aside and read, or left (lock held). */
  mainFile: "absent" | "claimed" | "busy";
  /** Spool files read this run. */
  files: number;
  /** Hooks passed to `ingestHook`. */
  hooks: number;
  /** Per-event outcomes across those hooks. */
  accepted: number;
  duplicate: number;
  conflict: number;
  rejected: number;
  /** Hooks the mapper mapped to nothing. */
  ignored: number;
  /** Lines that did not parse or were not a spool line; counted, never logged. */
  invalidLines: number;
  /** Oversized markers (`payload: null`): nothing to map, so skipped and counted. */
  oversized: number;
  /** Spool entries that are not regular files owned by this user; left alone. */
  unreadableFiles: number;
  /** Files deleted after their hooks committed. */
  removedFiles: number;
  /** Files left for the next run by the bound (a partly read file keeps only its unread rest). */
  deferredFiles: number;
  /** An ingest threw; every file read this run was kept for the next start. */
  failed: boolean;
}

interface Entry {
  sourceEventId: string;
  payload: Record<string, unknown>;
  spooledAt: string;
}

interface FilePlan {
  path: string;
  /** Byte offset just past the last line read; undefined when the whole file was read. */
  cut: number | undefined;
  mtime: Date;
}

/**
 * Replays the spool once. Never throws for spool content or a missing spool;
 * an ingest failure stops the run, keeps every file read, and sets `failed`.
 */
export async function replaySpool(options: SpoolReplayOptions): Promise<SpoolReplayReport> {
  const report = emptyReport();
  const { spoolDir, logger } = options;
  const now = options.now ?? Date.now;
  const maxHooks = options.maxHooks ?? DEFAULT_MAX_HOOKS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const dir = lstatOrUndefined(spoolDir);
  if (dir === undefined) return report;
  if (dir.isSymbolicLink() || !dir.isDirectory()) {
    logger?.warn("spool path is not a directory; nothing replayed");
    return report;
  }

  clearStale(spoolDir, now());
  report.mainFile = await claimMain(spoolDir, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS, now);

  const batch: Entry[] = [];
  const plans: FilePlan[] = [];
  const budget: Budget = { hooks: 0, bytes: 0, maxHooks, maxBytes };
  for (const name of spoolFiles(spoolDir)) {
    const path = join(spoolDir, name);
    if (spent(budget)) {
      report.deferredFiles += 1;
      continue;
    }
    const read = await readSpoolFile(path, budget);
    if (read === undefined) {
      report.unreadableFiles += 1;
      continue;
    }
    report.invalidLines += read.invalid;
    report.oversized += read.oversized;
    batch.push(...read.entries);
    if (read.cut === 0) {
      // Not one line fitted: the file waits, untouched.
      report.deferredFiles += 1;
      continue;
    }
    report.files += 1;
    plans.push({ path, cut: read.cut, mtime: read.mtime });
  }

  // Ingest order is history order: oldest hook first; ties keep spool order (sort is stable).
  batch.sort((a, b) => compareTimestamps(a.spooledAt, b.spooledAt));
  for (const entry of batch) {
    try {
      const res = await options.source.ingestHook({
        sourceEventId: entry.sourceEventId,
        payload: entry.payload,
        late: true,
        receivedAt: entry.spooledAt,
      });
      report.hooks += 1;
      if (res.ignored === true) report.ignored += 1;
      for (const r of res.results) {
        if (r.status === "accepted") report.accepted += 1;
        else if (r.status === "duplicate") report.duplicate += 1;
        else if (r.status === "conflict") report.conflict += 1;
        else report.rejected += 1;
      }
    } catch (error) {
      report.failed = true;
      // Name only: an error message can carry payload text.
      logger?.error({ errName: (error as Error).name }, "spool replay stopped; spool kept");
      break;
    }
  }

  if (!report.failed) {
    for (const plan of plans) {
      try {
        if (plan.cut !== undefined) {
          await keepRest(spoolDir, plan);
          report.deferredFiles += 1;
        }
        unlinkSync(plan.path);
        report.removedFiles += 1;
      } catch (error) {
        // The file stays; its hooks are duplicates next time.
        logger?.error({ errName: (error as Error).name }, "spool file not removed");
      }
    }
  }

  if (hasActivity(report)) logger?.info({ ...report }, "spool replayed");
  return report;
}

function emptyReport(): SpoolReplayReport {
  return {
    mainFile: "absent",
    files: 0,
    hooks: 0,
    accepted: 0,
    duplicate: 0,
    conflict: 0,
    rejected: 0,
    ignored: 0,
    invalidLines: 0,
    oversized: 0,
    unreadableFiles: 0,
    removedFiles: 0,
    deferredFiles: 0,
    failed: false,
  };
}

function hasActivity(r: SpoolReplayReport): boolean {
  return (
    r.mainFile !== "absent" ||
    r.files > 0 ||
    r.unreadableFiles > 0 ||
    r.deferredFiles > 0 ||
    r.failed
  );
}

// --- Files ---------------------------------------------------------------------------------

/** Spool files to read, oldest modification first, then by name. */
function spoolFiles(dir: string): string[] {
  const found: { name: string; mtime: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!SPOOL_NAME.test(name)) continue;
    const stats = lstatOrUndefined(join(dir, name));
    if (stats !== undefined) found.push({ name, mtime: stats.mtimeMs });
  }
  found.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return found.map((f) => f.name);
}

/** What one run may still read; shared across files and updated as lines are taken. */
interface Budget {
  hooks: number;
  bytes: number;
  maxHooks: number;
  maxBytes: number;
}

function spent(b: Budget): boolean {
  return b.hooks >= b.maxHooks || b.bytes >= b.maxBytes;
}

/** Whether the next line fits; the first line of a run always does, so every run makes progress. */
function fits(b: Budget, lineBytes: number): boolean {
  if (b.hooks === 0 && b.bytes === 0) return true;
  return b.hooks < b.maxHooks && b.bytes + lineBytes <= b.maxBytes;
}

interface FileRead {
  entries: Entry[];
  invalid: number;
  oversized: number;
  cut: number | undefined;
  mtime: Date;
}

/**
 * Reads lines while the budget allows, charging it as it goes. Refuses (undefined) anything that
 * is not a regular file owned by this user, without following a symlink. A line
 * over MAX_SPOOL_LINE_BYTES is skipped without being held in memory.
 */
async function readSpoolFile(path: string, budget: Budget): Promise<FileRead | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat();
    const uid = process.getuid?.();
    if (!stats.isFile() || (uid !== undefined && stats.uid !== uid)) return undefined;
    const out: FileRead = {
      entries: [],
      invalid: 0,
      oversized: 0,
      cut: undefined,
      mtime: stats.mtime,
    };
    let parts: Buffer[] = [];
    let partBytes = 0;
    let overflow = false;
    let lineStart = 0;
    let position = 0;
    const buffer = Buffer.alloc(CHUNK);

    // Returns false to stop reading (budget spent).
    const finish = (end: number): boolean => {
      const lineBytes = end - lineStart;
      if (!fits(budget, lineBytes)) {
        out.cut = lineStart;
        return false;
      }
      budget.bytes += lineBytes;
      const before = out.entries.length;
      if (overflow) out.invalid += 1;
      else if (partBytes > 0) classify(Buffer.concat(parts, partBytes).toString("utf8"), out);
      budget.hooks += out.entries.length - before;
      parts = [];
      partBytes = 0;
      overflow = false;
      lineStart = end;
      return true;
    };

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
      if (bytesRead === 0) break;
      let from = 0;
      while (from < bytesRead) {
        const nl = buffer.indexOf(0x0a, from);
        const stop = nl === -1 || nl >= bytesRead ? bytesRead : nl;
        const piece = stop - from;
        if (!overflow) {
          if (partBytes + piece > MAX_SPOOL_LINE_BYTES) {
            overflow = true;
            parts = [];
            partBytes = 0;
          } else if (piece > 0) {
            parts.push(Buffer.from(buffer.subarray(from, stop)));
            partBytes += piece;
          }
        }
        if (stop === bytesRead) break;
        // A complete line ends at the newline (included in its byte count).
        if (!finish(position + nl + 1)) return out;
        from = nl + 1;
      }
      position += bytesRead;
    }
    // A last line with no newline: a shim killed mid-append. Read it like any other line.
    if (position > lineStart) finish(position);
    return out;
  } finally {
    await handle.close();
  }
}

/** Parses one line into an entry, an oversized marker, or an invalid line. */
function classify(text: string, out: FileRead): void {
  if (text.trim() === "") return;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    out.invalid += 1;
    return;
  }
  const entry = spoolEntry(value);
  if (entry === "oversized") out.oversized += 1;
  else if (entry === undefined) out.invalid += 1;
  else out.entries.push(entry);
}

/** The shim's line shape exactly; read with `Object.hasOwn`, unknown keys refused (L-18, L-29). */
function spoolEntry(value: unknown): Entry | "oversized" | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (!Object.keys(value).every((key) => LINE_KEYS.has(key))) return undefined;
  if (!Object.hasOwn(value, "sourceEventId") || !Object.hasOwn(value, "spooledAt"))
    return undefined;
  if (!Object.hasOwn(value, "payload")) return undefined;
  const id = idSchema.safeParse(value.sourceEventId);
  if (!id.success || id.data.length > MAX_HOOK_SOURCE_EVENT_ID) return undefined;
  const at = timestampSchema.safeParse(value.spooledAt);
  if (!at.success) return undefined;
  const hasSize = Object.hasOwn(value, "payloadBytesAtLeast");
  if (value.payload === null) {
    const size = value.payloadBytesAtLeast;
    return hasSize && typeof size === "number" && Number.isSafeInteger(size) && size > 0
      ? "oversized"
      : undefined;
  }
  if (hasSize || !isPlainRecord(value.payload)) return undefined;
  return { sourceEventId: id.data, payload: value.payload, spooledAt: at.data };
}

/**
 * Copies the unread rest of a partly read file to a new `claude-code.replay-*`
 * file (written under a temporary name, then renamed, so it is complete when it
 * appears) with the original's mtime, so it keeps its place in the order.
 */
async function keepRest(dir: string, plan: FilePlan): Promise<void> {
  const tmp = join(dir, `${TEMP_PREFIX}rest-${randomUUID()}`);
  const src = await open(plan.path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const dst = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    try {
      const buffer = Buffer.alloc(CHUNK);
      let position = plan.cut ?? 0;
      for (;;) {
        const { bytesRead } = await src.read(buffer, 0, CHUNK, position);
        if (bytesRead === 0) break;
        await dst.write(buffer, 0, bytesRead);
        position += bytesRead;
      }
      await dst.sync();
    } finally {
      await dst.close();
    }
  } finally {
    await src.close();
  }
  utimesSync(tmp, plan.mtime, plan.mtime);
  renameSync(tmp, join(dir, `claude-code.replay-${randomUUID()}.jsonl`));
}

// --- The shim's lock (mkdir protocol, claude-code-shim.sh header) --------------------------

/** Renames `claude-code.jsonl` aside under the lock, so new shim writes start a fresh file. */
async function claimMain(
  dir: string,
  waitMs: number,
  now: () => number,
): Promise<SpoolReplayReport["mainFile"]> {
  const main = join(dir, SPOOL_FILE);
  if (lstatOrUndefined(main) === undefined) return "absent";
  const lock = join(dir, LOCK);
  const deadline = now() + waitMs;
  for (;;) {
    if (takeLock(lock)) break;
    if (breakStaleLock(dir, now()) && takeLock(lock)) break;
    if (now() >= deadline) return "busy";
    await new Promise((resolve) => setTimeout(resolve, NAP_MS));
  }
  try {
    const stats = lstatOrUndefined(main);
    // A symlink or other odd entry is never renamed into the replay set.
    if (stats === undefined || !stats.isFile()) return "absent";
    renameSync(main, join(dir, `claude-code.replay-${randomUUID()}.jsonl`));
    return "claimed";
  } finally {
    releaseLock(lock);
  }
}

function takeLock(lock: string): boolean {
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    return false;
  }
  try {
    writeFileSync(join(lock, "pid"), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    // An empty lock is judged by age, like a shim killed before writing its PID.
  }
  return true;
}

function releaseLock(lock: string): void {
  if (lockOwner(lock) === String(process.pid)) rmSync(lock, { recursive: true, force: true });
}

function lockOwner(lock: string): string {
  try {
    const path = join(lock, "pid");
    if (!lstatSync(path).isFile()) return "";
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The shim's rule: a lock is stale when its PID is not running, or when it has
 * no PID and is older than STALE_MS; a lock with a running PID is never broken.
 * Serialized by the break lock, so the lock judged is the lock moved.
 */
function breakStaleLock(dir: string, nowMs: number): boolean {
  const lock = join(dir, LOCK);
  const breaker = join(dir, BREAKER);
  try {
    mkdirSync(breaker, { mode: 0o700 });
  } catch {
    return false;
  }
  try {
    const stats = lstatOrUndefined(lock);
    if (stats === undefined || !stats.isDirectory()) return false;
    const owner = lockOwner(lock);
    const stale = /^[1-9]\d{0,9}$/.test(owner)
      ? !running(Number(owner))
      : owner === "" && nowMs - stats.mtimeMs > STALE_MS;
    if (!stale) return false;
    const aside = join(dir, `${TEMP_PREFIX}stale-${randomUUID()}`);
    renameSync(lock, aside);
    rmSync(aside, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmdirSync(breaker);
    } catch {
      // Left for the next start's stale check.
    }
  }
}

/** `kill -0`, as the shim checks it: any failure means not running. */
function running(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes what killed shims leave: a break lock (held for milliseconds, so one
 * older than STALE_MS has no live holder, and no one else can remove or replace
 * it meanwhile) and temporaries or set-aside locks older than STALE_MS.
 */
function clearStale(dir: string, nowMs: number): void {
  for (const name of readdirSync(dir)) {
    if (name !== BREAKER && !name.startsWith(TEMP_PREFIX)) continue;
    const path = join(dir, name);
    const stats = lstatOrUndefined(path);
    if (stats === undefined || nowMs - stats.mtimeMs <= STALE_MS) continue;
    try {
      // rmSync removes a symlink itself, never its target.
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Tried again next start.
    }
  }
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DrainOptions extends SpoolReplayOptions {
  /** Pause between runs, so live requests are served in between. */
  pauseMs?: number;
  signal?: AbortSignal;
}

/** Default pause between drain runs. */
export const DEFAULT_DRAIN_PAUSE_MS = 250;

/**
 * Runs `replaySpool` until nothing is deferred, a run fails or makes no
 * progress, or `signal` aborts: for after listen, so a huge spool is worked off
 * in bounded runs instead of holding the start. Returns the summed counts.
 */
export async function drainSpool(options: DrainOptions): Promise<SpoolReplayReport> {
  const total = emptyReport();
  for (;;) {
    if (options.signal?.aborted === true) return total;
    const run = await replaySpool(options);
    addReport(total, run);
    const progressed = run.hooks > 0 || run.removedFiles > 0;
    if (run.failed || run.deferredFiles === 0 || !progressed) return total;
    await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? DEFAULT_DRAIN_PAUSE_MS));
  }
}

function addReport(total: SpoolReplayReport, run: SpoolReplayReport): void {
  if (total.mainFile === "absent") total.mainFile = run.mainFile;
  for (const key of COUNT_KEYS) total[key] += run[key];
  total.deferredFiles = run.deferredFiles;
  total.failed = total.failed || run.failed;
}

const COUNT_KEYS = [
  "files",
  "hooks",
  "accepted",
  "duplicate",
  "conflict",
  "rejected",
  "ignored",
  "invalidLines",
  "oversized",
  "unreadableFiles",
  "removedFiles",
] as const;
