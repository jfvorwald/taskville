import { type ProjectState, projectStateHash, REDUCER_VERSION } from "@taskville/domain/reducer";
import { attention } from "@taskville/domain/selectors";
import type { StoredEnvelope } from "@taskville/protocol";
import type { Context, Hono } from "hono";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import type { UpkeepLogger } from "../storage/checkpoints.ts";
import type { Storage } from "../storage/index.ts";
import { ArchiveStates } from "./archive-state.ts";
import { stateAtSequence } from "./checkpoints.ts";
import { type Position, parsePosition } from "./position.ts";

// Timeline reads (ARCHITECTURE.md 7.3 and 7.4, contracts/http-api.md "Timelines"): the live
// recording of a project, read at any position by replaying its event log. Read routes only;
// the only write is the disposable checkpoint cache, and nothing here can reach the command service.

const LIVE_PREFIX = "live:";
const ARCHIVE_PREFIX = "archive:";
const ARCHIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_REPLAY_CHUNK = 1000;
const LIMIT = /^[1-9][0-9]{0,3}$/;
const CURSOR_PREFIX = "tl1.";

export interface TimelineRouteOptions {
  storage: Storage;
  /** Engine clock for `computedAt` and for attention at position 0. */
  now?: () => Date;
  /** Where checkpoint cache failures are logged. */
  logger?: UpkeepLogger;
  /** Most archive positions read at once when replaying archive state (default 1,000). */
  archiveReplayChunk?: number;
}

/** A timeline id that named a project, or why it did not. */
type TimelineLookup =
  | { projectId: string; head: number; archiveId?: string }
  | "not_found"
  | "unknown_project";

const bad = (c: Context<AppEnv>, message: string) => apiError(c, 400, "bad_request", message);

function lookup(storage: Storage, timelineId: string): TimelineLookup {
  if (timelineId.startsWith(ARCHIVE_PREFIX)) {
    const archiveId = timelineId.slice(ARCHIVE_PREFIX.length);
    if (!ARCHIVE_ID.test(archiveId)) return "not_found";
    const archive = storage.archives().get(archiveId);
    if (archive?.status !== "done") return "not_found";
    return { projectId: archive.projectId, head: archive.eventCount, archiveId };
  }
  if (!timelineId.startsWith(LIVE_PREFIX) || timelineId.length === LIVE_PREFIX.length) {
    return "not_found";
  }
  const projectId = timelineId.slice(LIVE_PREFIX.length);
  const head = storage.head(projectId);
  return head === undefined ? "unknown_project" : { projectId, head };
}

function lookupError(c: Context<AppEnv>, found: "not_found" | "unknown_project") {
  return found === "not_found"
    ? apiError(c, 404, "not_found", "No timeline with this ID")
    : apiError(c, 404, "unknown_project", "No project with this ID");
}

/** The stored event at `sequence`, read by its key. */
function eventAt(
  storage: Storage,
  projectId: string,
  sequence: number,
): StoredEnvelope | undefined {
  for (const event of storage.events(projectId, sequence - 1)) return event;
  return undefined;
}

/**
 * Resolves a timestamp against the whole log in one pass: the greatest sequence received at or
 * before `ms` (0 when none) and the smallest received at or after `msCeil` (undefined when none;
 * `msCeil` is `ms` unless the timestamp has a fraction finer than a millisecond). A
 * scan rather than a search, because the engine clock may step back and then `receivedAt` is not
 * sorted.
 */
function scanTime(
  storage: Storage,
  projectId: string,
  ms: number,
  msCeil: number,
): { atOrBefore: number; atOrAfter: number | undefined } {
  let atOrBefore = 0;
  let atOrAfter: number | undefined;
  for (const event of storage.events(projectId)) {
    const received = Date.parse(event.receivedAt);
    if (received <= ms) atOrBefore = event.ingestSequence;
    if (atOrAfter === undefined && received >= msCeil) atOrAfter = event.ingestSequence;
  }
  return { atOrBefore, atOrAfter };
}

/** The last sequence a position includes, from 0 (none) to the head. */
function resolveUpTo(
  storage: Storage,
  projectId: string,
  head: number,
  at: Position,
  archiveId?: string,
): number {
  if (at.kind === "sequence") return Math.min(at.sequence, head);
  // An archive is sorted by occurredAt, so the clock is searched, not scanned.
  if (archiveId) {
    return storage.archives().positionAtOrBefore(archiveId, new Date(at.ms).toISOString());
  }
  return scanTime(storage, projectId, at.ms, at.msCeil).atOrBefore;
}

/** The first sequence a position includes, from 1 to the head plus one (past the log). */
function resolveFrom(
  storage: Storage,
  projectId: string,
  head: number,
  at: Position,
  archiveId?: string,
): number {
  if (at.kind === "sequence") return Math.max(at.sequence, 1);
  if (archiveId) {
    return (
      storage.archives().positionAtOrBefore(archiveId, new Date(at.msCeil - 1).toISOString()) + 1
    );
  }
  return scanTime(storage, projectId, at.ms, at.msCeil).atOrAfter ?? head + 1;
}

/** Where a page resumes, and the last sequence the walk was pinned to when it began. */
interface CursorState {
  next: number;
  until: number;
}

function encodeCursor(timelineId: string, state: CursorState): string {
  const body = JSON.stringify([timelineId, state.next, state.until]);
  return CURSOR_PREFIX + Buffer.from(body).toString("base64url");
}

const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** What a cursor issued for `timelineId` says; undefined if it is not one of ours. */
function decodeCursor(timelineId: string, cursor: string): CursorState | undefined {
  if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
    const [id, next, until] = parsed as [unknown, unknown, unknown];
    if (id !== timelineId || !isSequence(next)) return undefined;
    if (!isSequence(until)) return undefined;
    return { next, until };
  } catch {
    return undefined;
  }
}

/**
 * Registered on the app from `createApp`, so Host, Origin and credential checks already ran;
 * the `read` scope admits the CLI token and a paired browser session, never the bridge token.
 */
export function registerTimelineRoutes(app: Hono<AppEnv>, options: TimelineRouteOptions): void {
  const { storage } = options;
  const now = options.now ?? (() => new Date());
  const archiveStates = new ArchiveStates(storage, {
    chunk: Math.max(1, Math.floor(options.archiveReplayChunk ?? DEFAULT_REPLAY_CHUNK)),
    logger: options.logger,
  });

  app.get("/v1/projects/:id/timelines", requireScope("read"), (c) => {
    const projectId = c.req.param("id");
    const head = storage.head(projectId);
    if (head === undefined) return apiError(c, 404, "unknown_project", "No project with this ID");
    const first = eventAt(storage, projectId, 1);
    const last = eventAt(storage, projectId, head);
    const archives = storage
      .archives()
      .listDone(projectId)
      .map((archive) => ({
        id: `${ARCHIVE_PREFIX}${archive.id}`,
        kind: "archive",
        archiveKind: archive.kind,
        label: archive.label,
        projectId,
        firstSequence: 1,
        lastSequence: archive.eventCount,
        firstAt: archive.firstAt,
        lastAt: archive.lastAt,
        eventCount: archive.eventCount,
      }));
    return c.json({
      projectId,
      timelines: [
        ...(first && last
          ? [
              {
                id: `${LIVE_PREFIX}${projectId}`,
                kind: "live",
                projectId,
                firstSequence: first.ingestSequence,
                lastSequence: last.ingestSequence,
                firstAt: first.receivedAt,
                lastAt: last.receivedAt,
                eventCount: last.ingestSequence,
              },
            ]
          : []),
        ...archives,
      ],
    });
  });

  app.get("/v1/timelines/:id/state", requireScope("read"), async (c) => {
    const timelineId = c.req.param("id");
    const found = lookup(storage, timelineId);
    if (typeof found === "string") return lookupError(c, found);
    const raw = c.req.query("at");
    const position = raw === undefined ? undefined : parsePosition(raw);
    if (!position) return bad(c, "at must be an ingest sequence or a zoned ISO 8601 timestamp");

    // Everything below is synchronous on the one connection, so no ingest lands in between.
    const { projectId, head, archiveId } = found;
    const at = resolveUpTo(storage, projectId, head, position, archiveId);
    if (archiveId) {
      // The nearest archive checkpoint plus the events after it; no attention for history.
      const state = await archiveStates.stateAt(archiveId, projectId, head, at);
      if (!state) return apiError(c, 404, "not_found", "No timeline with this ID");
      return c.json({
        timelineId,
        at,
        cursor: at,
        reducerVersion: state.reducerVersion,
        stateHash: projectStateHash(state),
        state,
        attention: [],
        computedAt: now().toISOString(),
      });
    }
    const atEvent = at === 0 ? undefined : eventAt(storage, projectId, at);
    const replayClock = atEvent ? Date.parse(atEvent.receivedAt) : now().getTime();
    // At the head the stored projection is the replay already done, if it is current.
    const stored = at === head ? storage.projection<ProjectState>(projectId) : undefined;
    const reuse = stored?.reducerVersion === REDUCER_VERSION && stored.head === at;
    const state = reuse
      ? stored.state
      : stateAtSequence(storage, projectId, at, options.logger ? { logger: options.logger } : {});
    return c.json({
      timelineId,
      at,
      cursor: at,
      reducerVersion: state.reducerVersion,
      stateHash: reuse ? stored.stateHash : projectStateHash(state),
      state,
      // Attention is a function of the clock; history asks what it looked like then.
      attention: attention(state, replayClock),
      computedAt: now().toISOString(),
    });
  });

  app.get("/v1/timelines/:id/events", requireScope("read"), (c) => {
    const timelineId = c.req.param("id");
    const found = lookup(storage, timelineId);
    if (typeof found === "string") return lookupError(c, found);
    const { projectId, head, archiveId } = found;

    const rawLimit = c.req.query("limit");
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      if (!LIMIT.test(rawLimit) || Number(rawLimit) > MAX_LIMIT) {
        return bad(c, `limit must be an integer from 1 to ${MAX_LIMIT}`);
      }
      limit = Number(rawLimit);
    }

    const rawFrom = c.req.query("from");
    const from = rawFrom === undefined ? undefined : parsePosition(rawFrom);
    if (rawFrom !== undefined && !from) return bad(c, "from must be a sequence or a timestamp");
    const rawTo = c.req.query("to");
    const to = rawTo === undefined ? undefined : parsePosition(rawTo);
    if (rawTo !== undefined && !to) return bad(c, "to must be a sequence or a timestamp");

    const rawCursor = c.req.query("cursor");
    let resume: CursorState | undefined;
    if (rawCursor !== undefined) {
      resume = decodeCursor(timelineId, rawCursor);
      if (resume === undefined) return bad(c, "cursor is not one this timeline issued");
    }

    // The cursor supersedes `from`, and carries the end as first resolved (`to`, else the head),
    // so later pages do not move when events are ingested between requests. A forged end past
    // the head is clamped to it, so the page that reaches the head is the last.
    const first =
      resume?.next ?? (from ? resolveFrom(storage, projectId, head, from, archiveId) : 1);
    const pinned = resume
      ? resume.until
      : to
        ? resolveUpTo(storage, projectId, head, to, archiveId)
        : head;
    const last = Math.min(pinned, head);

    let events: StoredEnvelope[] = [];
    if (first <= last) {
      if (archiveId) {
        events = storage.archives().events(archiveId, first, Math.min(last, first + limit - 1));
      } else {
        for (const event of storage.events(projectId, first - 1)) {
          if (event.ingestSequence > last || events.length >= limit) break;
          events.push(event);
        }
      }
    }
    const lastSent = events.at(-1)?.ingestSequence;
    const nextCursor =
      lastSent !== undefined && lastSent < last
        ? encodeCursor(timelineId, { next: lastSent + 1, until: last })
        : null;
    return c.json({ timelineId, events, nextCursor });
  });
}
