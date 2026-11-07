// The read model behind the Worker's `/v1`: one seeded `packages/demo` run, folded with the
// domain reducer, answered in the engine's shapes and checked against the protocol schemas.
// Nothing here reads a clock or the network: the Worker's clock is the run's last event, so the
// same release shows the same city on every visit.

import { CALM, parseDuration, runOffline } from "@taskville/demo";
import { type ProjectState, projectStateHash, replay } from "@taskville/domain/reducer";
import { attention } from "@taskville/domain/selectors";
import {
  type Attention,
  type ProjectsResponse,
  projectsResponseSchema,
  type SnapshotResponse,
  type StoredEnvelope,
  snapshotResponseSchema,
  sseFrameSchema,
} from "@taskville/protocol";
import type { SseMessage } from "./sse.ts";

export const DEMO_PROJECT_ID = "demo";
const DEMO_NAME = "Taskville demo";
const SEED = 1;
const DURATION = "20m";
const LIVE_PREFIX = "live:";
const CURSOR_PREFIX = "tl1.";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

interface Demo {
  events: StoredEnvelope[];
  head: number;
  /** The run's last event time: the Worker's "now". */
  clockMs: number;
  snapshot: SnapshotResponse;
  projects: ProjectsResponse;
  /** Event frames, validated against the SSE schema once, index = ingest sequence - 1. */
  frames: SseMessage[];
}

let cached: Demo | undefined;

function demo(): Demo {
  if (cached !== undefined) return cached;
  const run = runOffline({
    seed: SEED,
    pace: CALM,
    durationMs: parseDuration(DURATION),
    projectId: DEMO_PROJECT_ID,
  });
  const events = run.events;
  const last = events.at(-1);
  if (last === undefined) throw new Error("The demo run produced no events");
  const clockMs = Date.parse(last.receivedAt);
  const head = events.length;
  const snapshot = snapshotResponseSchema.parse({
    projectId: DEMO_PROJECT_ID,
    cursor: head,
    reducerVersion: run.state.reducerVersion,
    stateHash: run.stateHash,
    state: run.state,
    attention: attention(run.state, clockMs),
    computedAt: new Date(clockMs).toISOString(),
  });
  const projects = projectsResponseSchema.parse({
    projects: [
      {
        id: DEMO_PROJECT_ID,
        name: DEMO_NAME,
        roots: [],
        builtin: false,
        head,
        lastEventAt: last.receivedAt,
      },
    ],
  });
  const frames = events.map((event) => {
    const frame = sseFrameSchema.parse({
      event: "event",
      id: event.ingestSequence,
      data: event,
    });
    return { event: "event", data: JSON.stringify(frame.data), id: String(event.ingestSequence) };
  });
  cached = { events, head, clockMs, snapshot, projects, frames };
  return cached;
}

export const isDemoProject = (id: string): boolean => id === DEMO_PROJECT_ID;

export const projectsBody = (): ProjectsResponse => demo().projects;
export const snapshotBody = (): SnapshotResponse => demo().snapshot;
export const demoHead = (): number => demo().head;

/** Event frames after a cursor, or `undefined` when the cursor is ahead of the head. */
export function eventFrames(after: number): SseMessage[] | undefined {
  const { head, frames } = demo();
  return after > head ? undefined : frames.slice(after);
}

/** `needs_you` and `trouble` records of the demo project, as the attention stream's first frame. */
export function attentionSnapshotFrame(): SseMessage {
  const { snapshot, clockMs } = demo();
  const records: Attention[] = snapshot.attention.filter((record) => record.level !== "waiting");
  return {
    event: "snapshot",
    data: JSON.stringify({
      projects: [{ projectId: DEMO_PROJECT_ID, name: DEMO_NAME, attention: records }],
      computedAt: new Date(clockMs).toISOString(),
    }),
  };
}

// Timelines: the live recording of the demo project, read at any position.

type Position = { kind: "sequence"; sequence: number } | { kind: "time"; ms: number };

const SEQUENCE = /^(0|[1-9][0-9]{0,15})$/;
const ZONED = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;

export function parsePosition(raw: string): Position | undefined {
  if (SEQUENCE.test(raw)) return { kind: "sequence", sequence: Number(raw) };
  const ms = ZONED.test(raw) ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(ms) ? undefined : { kind: "time", ms };
}

/** The last sequence a position includes, from 0 (none) to the head. */
function upTo(at: Position): number {
  const { events, head } = demo();
  if (at.kind === "sequence") return Math.min(at.sequence, head);
  let found = 0;
  for (const event of events)
    if (Date.parse(event.receivedAt) <= at.ms) found = event.ingestSequence;
  return found;
}

/** The first sequence a position includes, from 1 to the head plus one. */
function from(at: Position): number {
  const { events, head } = demo();
  if (at.kind === "sequence") return Math.max(at.sequence, 1);
  for (const event of events)
    if (Date.parse(event.receivedAt) >= at.ms) return event.ingestSequence;
  return head + 1;
}

const isLive = (timelineId: string): boolean => timelineId === `${LIVE_PREFIX}${DEMO_PROJECT_ID}`;

export function timelinesBody(projectId: string) {
  const { events, head } = demo();
  const first = events[0];
  const last = events[head - 1];
  return {
    projectId,
    timelines:
      first && last
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
        : [],
  };
}

/** The state at a position. A timeline the demo does not have answers with the empty state. */
export function timelineState(timelineId: string, at: Position) {
  const { events, clockMs } = demo();
  const sequence = isLive(timelineId) ? upTo(at) : 0;
  const state: ProjectState = replay(DEMO_PROJECT_ID, events.slice(0, sequence));
  const atEvent = sequence === 0 ? undefined : events[sequence - 1];
  const asOf = atEvent ? Date.parse(atEvent.receivedAt) : clockMs;
  return {
    timelineId,
    at: sequence,
    cursor: sequence,
    reducerVersion: state.reducerVersion,
    stateHash: projectStateHash(state),
    state,
    attention: attention(state, asOf),
    computedAt: new Date(clockMs).toISOString(),
  };
}

const encodeCursor = (timelineId: string, next: number, until: number): string =>
  CURSOR_PREFIX +
  btoa(JSON.stringify([timelineId, next, until]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

function decodeCursor(timelineId: string, cursor: string) {
  if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    const base64 = cursor.slice(CURSOR_PREFIX.length).replaceAll("-", "+").replaceAll("_", "/");
    const parsed: unknown = JSON.parse(atob(base64));
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
    const [id, next, until] = parsed as [unknown, unknown, unknown];
    if (id !== timelineId || !isSequence(next) || !isSequence(until)) return undefined;
    return { next, until };
  } catch {
    return undefined;
  }
}

const LIMIT = /^[1-9][0-9]{0,3}$/;

/** A page of the timeline's events, or the message of the 400 it deserves. */
export function timelineEvents(
  timelineId: string,
  query: URLSearchParams,
):
  | { error: string }
  | { body: { timelineId: string; events: StoredEnvelope[]; nextCursor: string | null } } {
  if (!isLive(timelineId)) return { body: { timelineId, events: [], nextCursor: null } };
  const { events, head } = demo();
  const rawLimit = query.get("limit");
  if (rawLimit !== null && (!LIMIT.test(rawLimit) || Number(rawLimit) > MAX_LIMIT)) {
    return { error: `limit must be an integer from 1 to ${MAX_LIMIT}` };
  }
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  const rawFrom = query.get("from");
  const fromAt = rawFrom === null ? undefined : parsePosition(rawFrom);
  if (rawFrom !== null && !fromAt) return { error: "from must be a sequence or a timestamp" };
  const rawTo = query.get("to");
  const toAt = rawTo === null ? undefined : parsePosition(rawTo);
  if (rawTo !== null && !toAt) return { error: "to must be a sequence or a timestamp" };
  const rawCursor = query.get("cursor");
  const resume = rawCursor === null ? undefined : decodeCursor(timelineId, rawCursor);
  if (rawCursor !== null && resume === undefined) {
    return { error: "cursor is not one this timeline issued" };
  }
  const first = resume?.next ?? (fromAt ? from(fromAt) : 1);
  const last = Math.min(resume ? resume.until : toAt ? upTo(toAt) : head, head);
  const page = first <= last ? events.slice(first - 1, Math.min(last, first - 1 + limit)) : [];
  const lastSent = page.at(-1)?.ingestSequence;
  const nextCursor =
    lastSent !== undefined && lastSent < last ? encodeCursor(timelineId, lastSent + 1, last) : null;
  return { body: { timelineId, events: page, nextCursor } };
}
