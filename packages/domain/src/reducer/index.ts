import { stateHash } from "../hash/index.ts";
import { initialRequestsState, type RequestsState, reduceRequests } from "./attention/index.ts";
import { type EntitiesState, initialEntities, reduceEntities } from "./entities/index.ts";
import type { DomainEvent } from "./entities/types.ts";

// The root reducer: `reduce(state, event)` is a pure function of its arguments (constitution
// III). Same events in the same order give byte-identical state and the same stateHash.
//
// Composition. State is ProjectMeta plus one set of keys per slice. A slice is a generic
// function `<S extends ItsState>(state: S, event) => S` that returns `{ ...state, ...its keys }`
// and never touches another slice's keys, plus an `initialX()` for its keys. `reduce` runs the
// slices in SLICES order, then sets `head`. Slices today: entities (reducer/entities/) and
// requests and commands (reducer/attention/, M1.08), in that order, so the requests slice sees
// this event's agents. To add a slice:
//   1. add its state type to ProjectState below,
//   2. spread its initial keys into initialState,
//   3. append its reducer to SLICES (wrapped, if it takes only its own keys, as requests is).
// Bump REDUCER_VERSION whenever the state shape or any rule changes, so stored projections are
// rebuilt from events at startup.

export type { Command, PendingRequest, RequestsState } from "./attention/index.ts";
export { compareTimestamps, MAX_OPEN_TOOL_CALLS_PER_AGENT } from "./entities/index.ts";
export type * from "./entities/types.ts";

export const REDUCER_VERSION = 4;

export interface ProjectMeta {
  readonly projectId: string;
  readonly reducerVersion: number;
  /** Ingest sequence of the last event applied; 0 before any. */
  readonly head: number;
}

export type ProjectState = ProjectMeta & EntitiesState & RequestsState;

type Slice = (state: ProjectState, event: DomainEvent) => ProjectState;

/** reduceRequests takes and returns only its own keys, and returns them unchanged on no effect. */
const requestsSlice: Slice = (state, event) => {
  const before = { requests: state.requests, commands: state.commands };
  const after = reduceRequests(before, event);
  return after === before
    ? state
    : { ...state, requests: after.requests, commands: after.commands };
};

const SLICES: readonly Slice[] = [reduceEntities, requestsSlice];

export function initialState(projectId: string): ProjectState {
  return {
    projectId,
    reducerVersion: REDUCER_VERSION,
    head: 0,
    ...initialEntities(),
    ...initialRequestsState(),
  };
}

export function reduce(state: ProjectState, event: DomainEvent): ProjectState {
  if (event.projectId !== state.projectId) {
    throw new Error(
      `reduce: event ${event.eventId} is for project ${event.projectId}, not ${state.projectId}`,
    );
  }
  let next = state;
  for (const slice of SLICES) next = slice(next, event);
  return next.head === event.ingestSequence ? next : { ...next, head: event.ingestSequence };
}

/** State after applying `events` in order to an empty project. */
export function replay(projectId: string, events: Iterable<DomainEvent>): ProjectState {
  let state = initialState(projectId);
  for (const event of events) state = reduce(state, event);
  return state;
}

/** `<reducerVersion>:<sha256 of canonical JSON>` of a project state (research R-7). */
export const projectStateHash = (state: ProjectState): string =>
  stateHash(state.reducerVersion, state);
