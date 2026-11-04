import { canonicalJson, sha256Hex } from "@taskville/domain/hash";
import type { StoredEnvelope } from "@taskville/protocol";
import {
  CHECKPOINT_BATCH,
  CHECKPOINT_INTERVAL,
  type CheckpointRow,
  trusted,
  UPKEEP_WAIT_MS,
  type UpkeepLogger,
  upkeepFields,
} from "./checkpoints.ts";
import type { ProjectionRecord, Storage } from "./storage.ts";

/**
 * What storage needs from a reducer. Passed in rather than imported so the
 * storage layer does not depend on the domain reducer (#9); the domain's
 * `REDUCER_VERSION`, initial state, and apply function plug in unchanged.
 */
export interface ProjectionReducer<S> {
  readonly version: number;
  initial(projectId: string): S;
  apply(state: S, event: StoredEnvelope): S;
}

/**
 * Replays a project's events in ingest-sequence order through `reducer` and
 * writes the resulting projection, all inside one transaction so the head
 * cannot move underneath the replay.
 */
export function rebuildProjection<S>(
  storage: Storage,
  projectId: string,
  reducer: ProjectionReducer<S>,
): ProjectionRecord<S> {
  return rebuild(storage, projectId, reducer, false);
}

/** The fold behind `rebuildProjection`; `withCheckpoints` also writes every replay checkpoint. */
function rebuild<S>(
  storage: Storage,
  projectId: string,
  reducer: ProjectionReducer<S>,
  withCheckpoints: boolean,
): ProjectionRecord<S> {
  return storage.transaction((tx) => {
    let state = reducer.initial(projectId);
    let head = 0;
    for (const event of tx.events(projectId)) {
      state = reducer.apply(state, event);
      head = event.ingestSequence;
      if (withCheckpoints && head % CHECKPOINT_INTERVAL === 0) {
        tx.writeCheckpoint({ projectId, sequence: head, reducerVersion: reducer.version, state });
      }
    }
    const stateHash = tx.writeProjection({
      projectId,
      reducerVersion: reducer.version,
      head,
      state,
    });
    return { projectId, reducerVersion: reducer.version, head, stateHash, state };
  });
}

/**
 * Boot step, run before the HTTP server listens: rebuilds every project whose
 * projection is missing, was produced by a different reducer version, or lags
 * the project head, writing its replay checkpoints as it folds. A project whose
 * projection is fresh but whose log predates checkpoints gets the missing ones
 * backfilled. Returns the IDs it rebuilt.
 */
export function rebuildStaleProjections<S>(
  storage: Storage,
  reducer: ProjectionReducer<S>,
  options: { logger?: UpkeepLogger } = {},
): string[] {
  const rebuilt: string[] = [];
  for (const project of storage.projects()) {
    const projection = storage.projection(project.id);
    const fresh =
      projection !== undefined &&
      projection.reducerVersion === reducer.version &&
      projection.head === project.head;
    if (fresh) {
      backfillCheckpoints(storage, project.id, project.head, reducer, options.logger);
      continue;
    }
    rebuild(storage, project.id, reducer, true);
    rebuilt.push(project.id);
  }
  return rebuilt;
}

/** True for SQLite's busy and locked errors (another connection holds the write lock) and for a spent upkeep budget. */
export function isBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { errcode, message } = error as { errcode?: unknown; message?: unknown };
  return (
    errcode === 5 ||
    errcode === 6 ||
    (typeof message === "string" && /database is (locked|busy)|wait budget spent/.test(message))
  );
}

/**
 * Writes the checkpoints a fresh project lacks (a log that predates them); a complete cache costs
 * one query. Best effort: the fold is read-only and the write waits at most the upkeep budget, so
 * a busy write lock skips the backfill (a later seek fills the cache) instead of aborting boot.
 * Any other write error is logged once, without bodies, and boot continues. A row at a multiple of
 * the interval that is not trustworthy (wrong version, corrupt, wrong hash or head) counts as missing.
 */
function backfillCheckpoints<S>(
  storage: Storage,
  projectId: string,
  head: number,
  reducer: ProjectionReducer<S>,
  logger: UpkeepLogger | undefined,
): void {
  const cache = storage.checkpoints();
  const stored = new Set(cache.sequences(projectId));
  const missing = new Set<number>();
  for (let sequence = CHECKPOINT_INTERVAL; sequence <= head; sequence += CHECKPOINT_INTERVAL) {
    const row = stored.has(sequence) ? cache.get(projectId, sequence) : undefined;
    if (!row || !trusted(row, reducer.version, projectId)) missing.add(sequence);
  }
  if (missing.size === 0) return;
  const last = Math.max(...missing);
  // Each batch is written as soon as it fills, after stepping past the event cursor, so at most
  // CHECKPOINT_BATCH rows of state are held between writes. Only the checkpoint writes are best
  // effort; a failed event read or reducer step is not a cache failure and aborts boot.
  cache.withWaitBudget(UPKEEP_WAIT_MS, () => {
    let state = reducer.initial(projectId);
    let position = 0;
    while (position < last) {
      const rows: CheckpointRow[] = [];
      for (const event of storage.events(projectId, position)) {
        state = reducer.apply(state, event);
        const sequence = event.ingestSequence;
        position = sequence;
        if (missing.has(sequence)) {
          const json = canonicalJson(state);
          rows.push({
            sequence,
            reducerVersion: reducer.version,
            stateHash: `${reducer.version}:${sha256Hex(json)}`,
            stateJson: json,
          });
        }
        if (sequence >= last || rows.length >= CHECKPOINT_BATCH) break;
      }
      if (rows.length === 0) break;
      try {
        cache.put(projectId, rows);
      } catch (error) {
        if (!isBusy(error)) logger?.warn(upkeepFields(error), "checkpoint backfill failed");
        return;
      }
    }
  });
}
