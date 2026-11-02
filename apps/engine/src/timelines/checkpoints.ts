import { canonicalJson, sha256Hex, stateHash } from "@taskville/domain/hash";
import type { ProjectState } from "@taskville/domain/reducer";
import { domainReducer } from "../ingest/index.ts";
import type { CheckpointRow, ProjectionReducer, Storage } from "../storage/index.ts";

// Replay checkpoints (ARCHITECTURE.md 7.4; constitution II and VI). A checkpoint is the reducer
// state after the first N events, kept every CHECKPOINT_INTERVAL events so a seek replays at most
// that many. Checkpoints are disposable caches: any that is not provably right is ignored and
// rebuilt, and the result always equals a full replay.
//
// Write policy: lazy. Ingest is untouched (the hot path pays nothing); the first read of a
// position writes the checkpoints it passes over, so later seeks anywhere before it are cheap.

/** Events between checkpoints. */
export const CHECKPOINT_INTERVAL = 500;

export interface StateAtOptions {
  reducer?: ProjectionReducer<ProjectState>;
  interval?: number;
}

/** The state if `row` is trustworthy for `reducer`: right version, parses, and matches its hash. */
function trusted(
  row: CheckpointRow,
  reducer: ProjectionReducer<ProjectState>,
): ProjectState | undefined {
  if (row.reducerVersion !== reducer.version) return undefined;
  try {
    const state = JSON.parse(row.stateJson) as ProjectState;
    return stateHash(reducer.version, state) === row.stateHash ? state : undefined;
  } catch {
    return undefined;
  }
}

/** Runs cache upkeep; a cache that cannot be written (a busy database) costs speed, never correctness. */
function attempt(fn: () => void): void {
  try {
    fn();
  } catch {
    // Disposable cache: ignore.
  }
}

/**
 * The project state after events 1..`upTo` (0 is the initial state; callers clamp to the head).
 * Loads the nearest trusted checkpoint at or before `upTo`, applies the events after it, and
 * writes the checkpoints it passed that were missing.
 */
export function stateAtSequence(
  storage: Storage,
  projectId: string,
  upTo: number,
  options: StateAtOptions = {},
): ProjectState {
  const reducer = options.reducer ?? domainReducer;
  const interval = options.interval ?? CHECKPOINT_INTERVAL;
  const cache = storage.checkpoints();
  const head = storage.head(projectId) ?? 0;

  // Cache upkeep needs the write lock; if another connection holds it the read still succeeds
  // from the log, so upkeep is best effort and a skipped prune only costs a recheck next time.
  attempt(() => cache.prune(projectId, reducer.version, head));
  const stored = new Set(cache.sequences(projectId));

  let state = reducer.initial(projectId);
  let base = 0;
  const candidates = [...stored].filter((s) => s <= upTo).sort((a, b) => b - a);
  for (const sequence of candidates) {
    const row = cache.get(projectId, sequence);
    const loaded = row && trusted(row, reducer);
    if (loaded) {
      state = loaded;
      base = sequence;
      break;
    }
    attempt(() => cache.delete(projectId, sequence));
    stored.delete(sequence);
  }

  // Collected during the walk and written after it, so no write happens under the event cursor.
  const fresh: CheckpointRow[] = [];
  if (base < upTo) {
    for (const event of storage.events(projectId, base)) {
      state = reducer.apply(state, event);
      const sequence = event.ingestSequence;
      if (sequence % interval === 0 && !stored.has(sequence)) {
        const json = canonicalJson(state);
        fresh.push({
          sequence,
          reducerVersion: reducer.version,
          stateHash: `${reducer.version}:${sha256Hex(json)}`,
          stateJson: json,
        });
      }
      if (sequence >= upTo) break;
    }
  }
  attempt(() => cache.put(projectId, fresh));
  return state;
}
