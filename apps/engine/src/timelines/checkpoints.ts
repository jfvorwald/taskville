import { canonicalJson, sha256Hex } from "@taskville/domain/hash";
import type { ProjectState } from "@taskville/domain/reducer";
import { domainReducer } from "../ingest/index.ts";
import { putInBatches, trusted, type UpkeepLogger } from "../storage/checkpoints.ts";
import {
  CHECKPOINT_INTERVAL,
  type CheckpointRow,
  type ProjectionReducer,
  type Storage,
  UPKEEP_WAIT_MS,
} from "../storage/index.ts";
import { isBusy } from "../storage/rebuild.ts";

// Replay checkpoints (ARCHITECTURE.md 7.4; constitution II and VI). A checkpoint is the reducer
// state after the first N events, kept every CHECKPOINT_INTERVAL events so a seek replays at most
// that many. Checkpoints are disposable caches: any that is not provably right is ignored and
// rebuilt, and the result always equals a full replay.
//
// Write policy: eager on ingest commit (the pipeline writes one whenever the head crosses a
// multiple of the interval), plus lazy on read to backfill logs that predate checkpoints, a
// reducer-version change, or a pruned row.

export { CHECKPOINT_INTERVAL };

export interface StateAtOptions {
  reducer?: ProjectionReducer<ProjectState>;
  interval?: number;
  /** Where a cache write failure other than a busy lock is logged. */
  logger?: UpkeepLogger;
}

/** Runs cache upkeep; a cache that cannot be written costs speed, never correctness. Busy and spent-budget errors are silent; any other is logged once, without bodies. */
function attempt(fn: () => void, logger: UpkeepLogger | undefined): void {
  try {
    fn();
  } catch (error) {
    if (isBusy(error)) return;
    const { errcode, message } = error as { errcode?: unknown; message?: unknown };
    logger?.warn({ errcode, message }, "checkpoint cache upkeep failed");
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
  return storage
    .checkpoints()
    .withWaitBudget(UPKEEP_WAIT_MS, () => stateAt(storage, projectId, upTo, options));
}

function stateAt(
  storage: Storage,
  projectId: string,
  upTo: number,
  options: StateAtOptions,
): ProjectState {
  const reducer = options.reducer ?? domainReducer;
  const interval = options.interval ?? CHECKPOINT_INTERVAL;
  const logger = options.logger;
  const cache = storage.checkpoints();
  const head = storage.head(projectId) ?? 0;

  // Cache upkeep needs the write lock; if another connection holds it the read still succeeds
  // from the log, so upkeep is best effort; every step shares the one wait budget set by the caller.
  attempt(() => cache.prune(projectId, reducer.version, head), logger);
  const stored = new Set(cache.sequences(projectId));

  let state = reducer.initial(projectId);
  let base = 0;
  const candidates = [...stored].filter((s) => s <= upTo).sort((a, b) => b - a);
  for (const sequence of candidates) {
    const row = cache.get(projectId, sequence);
    const loaded = row && trusted(row, reducer.version, projectId);
    if (loaded) {
      state = loaded;
      base = sequence;
      break;
    }
    attempt(() => cache.delete(projectId, sequence), logger);
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
  attempt(() => putInBatches(cache, projectId, fresh), logger);
  return state;
}
