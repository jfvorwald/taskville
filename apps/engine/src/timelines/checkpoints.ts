import { canonicalJson, sha256Hex } from "@taskville/domain/hash";
import type { ProjectState } from "@taskville/domain/reducer";
import { domainReducer } from "../ingest/index.ts";
import {
  CHECKPOINT_BATCH,
  trusted,
  type UpkeepLogger,
  upkeepFields,
} from "../storage/checkpoints.ts";
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

/** Runs cache upkeep; a cache that cannot be written costs speed, never correctness. Busy and spent-budget errors are silent; any other is logged once, errcode only. */
function attempt(
  fn: () => void,
  logger: UpkeepLogger | undefined,
  once?: WeakMap<UpkeepLogger, Set<unknown>>,
): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    if (!isBusy(error) && !(logger && once && alreadyLogged(once, logger, error))) {
      logger?.warn(upkeepFields(error), "checkpoint cache upkeep failed");
    }
    return false;
  }
}

/** Seek-path deletes repeat per untrusted row; each errcode is logged once per logger. */
const loggedDeleteFailures = new WeakMap<UpkeepLogger, Set<unknown>>();

function alreadyLogged(
  once: WeakMap<UpkeepLogger, Set<unknown>>,
  logger: UpkeepLogger,
  error: unknown,
): boolean {
  const code = upkeepFields(error).errcode;
  const seen = once.get(logger) ?? new Set<unknown>();
  once.set(logger, seen);
  if (seen.has(code)) return true;
  seen.add(code);
  return false;
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
    attempt(() => cache.delete(projectId, sequence), logger, loggedDeleteFailures);
    stored.delete(sequence);
  }

  // Each batch of fresh rows is written as soon as it fills, after stepping past the event
  // cursor (no write happens under it), so at most CHECKPOINT_BATCH rows are held between writes.
  // After a failed write no later batch is tried; the seek still answers from the log.
  let writing = true;
  let position = base;
  while (position < upTo) {
    const before = position;
    const fresh: CheckpointRow[] = [];
    for (const event of storage.events(projectId, position)) {
      state = reducer.apply(state, event);
      const sequence = event.ingestSequence;
      position = sequence;
      if (writing && sequence % interval === 0 && !stored.has(sequence)) {
        const json = canonicalJson(state);
        fresh.push({
          sequence,
          reducerVersion: reducer.version,
          stateHash: `${reducer.version}:${sha256Hex(json)}`,
          stateJson: json,
        });
      }
      if (sequence >= upTo || fresh.length >= CHECKPOINT_BATCH) break;
    }
    if (fresh.length > 0 && !attempt(() => cache.put(projectId, fresh), logger)) writing = false;
    if (position === before) break;
  }
  return state;
}
