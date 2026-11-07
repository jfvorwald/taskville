// The read model behind the Worker's `/v1`: one seeded `packages/demo` run, folded with the
// domain reducer, answered in the engine's shapes and checked against the protocol schemas.
//
// The heavy work (generating the run, validating it, folding every prefix of it) happens once,
// when the module loads, which the platform counts against startup rather than a request. The
// run is built at the demo's own fixed epoch, so no clock is read here. Time enters on the first
// demo request of an isolate: every timestamp is shifted so the run ends at that moment, and
// the shift is a string rewrite of already-built JSON, not another run. Shifting every timestamp
// of a state gives exactly the state (and state hash) a replay of the shifted events gives,
// because the reducer only stores and compares timestamps.

import { CALM, parseDuration, runOffline } from "@taskville/demo";
import {
  initialState,
  type ProjectState,
  projectStateHash,
  reduce,
} from "@taskville/domain/reducer";
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
import { type Position, parsePosition } from "../../../apps/engine/src/timelines/position.ts";
import type { SseMessage } from "./sse.ts";

export { parsePosition };

export const DEMO_PROJECT_ID = "demo";
export const UNSORTED_PROJECT_ID = "unsorted";
const DEMO_NAME = "Taskville demo";
const UNSORTED_NAME = "Unsorted";
const SEED = 1;
const DURATION = "20m";
const LIVE_PREFIX = "live:";
const CURSOR_PREFIX = "tl1.";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

interface Base {
  /** Canonical (unshifted) events, as JSON, index = ingest sequence - 1. */
  eventJson: string[];
  /** `states[n]` is the canonical state after `n` events. */
  states: ProjectState[];
  head: number;
  lastMs: number;
}

function build(): Base {
  const run = runOffline({
    seed: SEED,
    pace: CALM,
    durationMs: parseDuration(DURATION),
    projectId: DEMO_PROJECT_ID,
  });
  const last = run.events.at(-1);
  if (last === undefined) throw new Error("The demo run produced no events");
  const eventJson = run.events.map((event) =>
    JSON.stringify(
      sseFrameSchema.parse({ event: "event", id: event.ingestSequence, data: event }).data,
    ),
  );
  let state = initialState(DEMO_PROJECT_ID);
  const states = [state];
  for (const event of run.events) {
    state = reduce(state, event);
    states.push(state);
  }
  return { eventJson, states, head: run.events.length, lastMs: Date.parse(last.receivedAt) };
}

const base: Base = build();
const unsortedState: ProjectState = initialState(UNSORTED_PROJECT_ID);
const unsortedHash = projectStateHash(unsortedState);

const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
const shifted = (text: string, delta: number): string =>
  delta === 0 ? text : text.replace(ISO, (at) => new Date(Date.parse(at) + delta).toISOString());

interface Rebased {
  delta: number;
  /** The Worker's "now": the first demo request of this isolate, which the run ends at. */
  clockMs: number;
  clockIso: string;
  eventJson: string[];
  frames: SseMessage[];
  lastEventAt: string;
  events?: StoredEnvelope[];
  states: Map<number, { state: ProjectState; hash: string }>;
  snapshot?: SnapshotResponse;
}

let rebased: Rebased | undefined;

function demo(): Rebased {
  if (rebased !== undefined) return rebased;
  const clockMs = Date.now();
  const delta = clockMs - base.lastMs;
  const eventJson = base.eventJson.map((json) => shifted(json, delta));
  rebased = {
    delta,
    clockMs,
    clockIso: new Date(clockMs).toISOString(),
    eventJson,
    frames: eventJson.map((data, index) => ({ event: "event", data, id: String(index + 1) })),
    lastEventAt: new Date(clockMs).toISOString(),
    states: new Map(),
  };
  return rebased;
}

function events(): StoredEnvelope[] {
  const run = demo();
  run.events ??= run.eventJson.map((json) => JSON.parse(json) as StoredEnvelope);
  return run.events;
}

/** The demo state after `sequence` events, shifted to the Worker's clock, with its hash. */
function stateAfter(sequence: number): { state: ProjectState; hash: string } {
  const run = demo();
  const known = run.states.get(sequence);
  if (known !== undefined) return known;
  const canonical = base.states[sequence];
  if (canonical === undefined) throw new RangeError(`No demo state after ${sequence} events`);
  const state = JSON.parse(shifted(JSON.stringify(canonical), run.delta)) as ProjectState;
  const entry = { state, hash: projectStateHash(state) };
  run.states.set(sequence, entry);
  return entry;
}

export const isKnownProject = (id: string): boolean =>
  id === DEMO_PROJECT_ID || id === UNSORTED_PROJECT_ID;

export const projectHead = (id: string): number => (id === DEMO_PROJECT_ID ? base.head : 0);

export function projectsBody(): ProjectsResponse {
  return projectsResponseSchema.parse({
    projects: [
      {
        id: DEMO_PROJECT_ID,
        name: DEMO_NAME,
        roots: [],
        builtin: false,
        head: base.head,
        lastEventAt: demo().lastEventAt,
      },
      {
        id: UNSORTED_PROJECT_ID,
        name: UNSORTED_NAME,
        roots: [],
        builtin: true,
        head: 0,
        lastEventAt: null,
      },
    ],
  });
}

/** The snapshot of a known project, or undefined for an unknown one. */
export function snapshotBody(projectId: string): SnapshotResponse | undefined {
  const run = demo();
  if (projectId === UNSORTED_PROJECT_ID) {
    return snapshotResponseSchema.parse({
      projectId,
      cursor: 0,
      reducerVersion: unsortedState.reducerVersion,
      stateHash: unsortedHash,
      state: unsortedState,
      attention: [],
      computedAt: run.clockIso,
    });
  }
  if (projectId !== DEMO_PROJECT_ID) return undefined;
  run.snapshot ??= (() => {
    const { state, hash } = stateAfter(base.head);
    return snapshotResponseSchema.parse({
      projectId,
      cursor: base.head,
      reducerVersion: state.reducerVersion,
      stateHash: hash,
      state,
      attention: attention(state, run.clockMs),
      computedAt: run.clockIso,
    });
  })();
  return run.snapshot;
}

/** Event frames after a cursor, or `undefined` when the cursor is ahead of the head. */
export function eventFrames(projectId: string, after: number): SseMessage[] | undefined {
  if (after > projectHead(projectId)) return undefined;
  return projectId === DEMO_PROJECT_ID ? demo().frames.slice(after) : [];
}

/** `needs_you` and `trouble` records of every project, as the attention stream's first frame. */
export function attentionSnapshotFrame(): SseMessage {
  const snapshot = snapshotBody(DEMO_PROJECT_ID);
  const records: Attention[] = (snapshot?.attention ?? []).filter(
    (record) => record.level !== "waiting",
  );
  return {
    event: "snapshot",
    data: JSON.stringify({
      projects: [
        { projectId: DEMO_PROJECT_ID, name: DEMO_NAME, attention: records },
        { projectId: UNSORTED_PROJECT_ID, name: UNSORTED_NAME, attention: [] },
      ],
      computedAt: demo().clockIso,
    }),
  };
}

// Timelines: the live recording of a project, read at any position.

/** The last sequence a position includes, from 0 (none) to the head. */
function upTo(at: Position): number {
  if (at.kind === "sequence") return Math.min(at.sequence, base.head);
  let found = 0;
  for (const event of events()) {
    if (Date.parse(event.receivedAt) <= at.ms) found = event.ingestSequence;
  }
  return found;
}

/** The first sequence a position includes, from 1 to the head plus one. */
function from(at: Position): number {
  if (at.kind === "sequence") return Math.max(at.sequence, 1);
  for (const event of events()) {
    if (Date.parse(event.receivedAt) >= at.msCeil) return event.ingestSequence;
  }
  return base.head + 1;
}

const isLive = (timelineId: string): boolean => timelineId === `${LIVE_PREFIX}${DEMO_PROJECT_ID}`;

export function timelinesBody(projectId: string) {
  const all = events();
  const first = all[0];
  const last = all[base.head - 1];
  return {
    projectId,
    timelines:
      projectId === DEMO_PROJECT_ID && first && last
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
  const run = demo();
  const sequence = isLive(timelineId) ? upTo(at) : 0;
  const { state, hash } = stateAfter(sequence);
  const atEvent = sequence === 0 ? undefined : events()[sequence - 1];
  const asOf = atEvent ? Date.parse(atEvent.receivedAt) : run.clockMs;
  return {
    timelineId,
    at: sequence,
    cursor: sequence,
    reducerVersion: state.reducerVersion,
    stateHash: hash,
    state,
    attention: attention(state, asOf),
    computedAt: run.clockIso,
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
    const encoded = cursor.slice(CURSOR_PREFIX.length).replaceAll("-", "+").replaceAll("_", "/");
    const parsed: unknown = JSON.parse(atob(encoded));
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
    const [id, next, until] = parsed as [unknown, unknown, unknown];
    if (id !== timelineId || !isSequence(next) || !isSequence(until)) return undefined;
    return { next, until };
  } catch {
    return undefined;
  }
}

const LIMIT = /^[1-9][0-9]{0,3}$/;

type EventsPage = { timelineId: string; events: StoredEnvelope[]; nextCursor: string | null };

/** A page of the timeline's events, or the message of the 400 it deserves. */
export function timelineEvents(
  timelineId: string,
  query: URLSearchParams,
): { error: string } | { body: EventsPage } {
  if (!isLive(timelineId)) return { body: { timelineId, events: [], nextCursor: null } };
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
  const last = Math.min(resume ? resume.until : toAt ? upTo(toAt) : base.head, base.head);
  const page = first <= last ? events().slice(first - 1, Math.min(last, first - 1 + limit)) : [];
  const lastSent = page.at(-1)?.ingestSequence;
  const nextCursor =
    lastSent !== undefined && lastSent < last ? encodeCursor(timelineId, lastSent + 1, last) : null;
  return { body: { timelineId, events: page, nextCursor } };
}
