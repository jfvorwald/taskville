import { canonicalJson, stateHash } from "@taskville/domain/hash";
import type { ProjectState } from "@taskville/domain/reducer";
import { domainReducer } from "../ingest/index.ts";
import type { WaitBudget } from "../storage/archives.ts";
import { trusted, type UpkeepLogger, upkeepFields } from "../storage/checkpoints.ts";
import { type Storage, UPKEEP_WAIT_MS } from "../storage/index.ts";
import { isBusy } from "../storage/rebuild.ts";

// Archive state seeks (M8.09; ARCHITECTURE.md 7.4). An archive is immutable, so its checkpoints
// are built once, lazily after the first state seek, at every ARCHIVE_CHECKPOINT_INTERVAL
// positions. A seek loads the nearest trusted one at or below the position and reduces the rest
// (at most interval - 1 events). Checkpoints are disposable: one that is not provably right is
// skipped, and the result always equals a full replay. Replays yield to the event loop between
// chunks, so a long one never blocks live ingest.

export const ARCHIVE_CHECKPOINT_INTERVAL = 1000;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface ArchiveStateOptions {
  /** Most positions read at once when replaying. */
  chunk: number;
  logger?: UpkeepLogger | undefined;
}

export class ArchiveStates {
  readonly #storage: Storage;
  readonly #chunk: number;
  readonly #logger: UpkeepLogger | undefined;
  /** One build per archive at a time: concurrent seeks share it. */
  readonly #building = new Map<string, Promise<void>>();

  constructor(storage: Storage, options: ArchiveStateOptions) {
    this.#storage = storage;
    this.#chunk = options.chunk;
    this.#logger = options.logger;
  }

  /**
   * The state after archive events 1..`upTo`, or undefined when the archive vanished meanwhile
   * (pruned during a yield). Starts the checkpoint build if some are missing.
   */
  async stateAt(
    archiveId: string,
    projectId: string,
    head: number,
    upTo: number,
  ): Promise<ProjectState | undefined> {
    // One short lock-wait budget for the upkeep this seek does (deletes, then the prune).
    const budget = { remaining: UPKEEP_WAIT_MS };
    const { state, base } = this.#nearest(archiveId, projectId, upTo, undefined, budget);
    const reduced = await this.#replay(archiveId, state, base, upTo, this.#chunk);
    if (!this.#storage.archives().get(archiveId)) return undefined;
    this.#ensureBuilt(archiveId, projectId, head, budget);
    return reduced;
  }

  /** The nearest trusted checkpoint at or below `upTo`, else the initial state at 0. */
  #nearest(
    archiveId: string,
    projectId: string,
    upTo: number,
    stored: Set<number> | undefined,
    budget: WaitBudget,
  ): { state: ProjectState; base: number } {
    const archives = this.#storage.archives();
    const version = domainReducer.version;
    const positions = archives.checkpointPositions(archiveId).filter((p) => p <= upTo);
    for (const position of positions.reverse()) {
      const row = archives.checkpoint(archiveId, position);
      const loaded = row && trusted(row, version, projectId);
      if (loaded) return { state: loaded, base: position };
      this.#attempt(() => archives.deleteCheckpoint(archiveId, position, budget));
      stored?.delete(position);
    }
    return { state: domainReducer.initial(projectId), base: 0 };
  }

  /**
   * Reduces events `base + 1`..`upTo` onto `state`, a chunk at a time with a yield between
   * chunks. `onChunk` sees the state after each chunk and may stop the replay by returning false.
   */
  async #replay(
    archiveId: string,
    from: ProjectState,
    base: number,
    upTo: number,
    chunk: number,
    onChunk?: (state: ProjectState, position: number) => boolean,
  ): Promise<ProjectState> {
    const archives = this.#storage.archives();
    let state = from;
    let start = base + 1;
    while (start <= upTo) {
      const stop = Math.min(upTo, start + chunk - 1);
      for (const event of archives.events(archiveId, start, stop)) {
        state = domainReducer.apply(state, event);
      }
      if (onChunk && !onChunk(state, stop)) return state;
      start = stop + 1;
      if (start <= upTo) await yieldToEventLoop();
    }
    return state;
  }

  #ensureBuilt(archiveId: string, projectId: string, head: number, budget: WaitBudget): void {
    if (this.#building.has(archiveId)) return;
    const archives = this.#storage.archives();
    const wanted = Math.floor(head / ARCHIVE_CHECKPOINT_INTERVAL);
    if (wanted === 0) return;
    if (!this.#attempt(() => archives.pruneCheckpoints(archiveId, domainReducer.version, budget))) {
      return;
    }
    if (archives.checkpointPositions(archiveId).length >= wanted) return;
    const build = this.#build(archiveId, projectId, head)
      .catch((error: unknown) => {
        // A closed database or a busy lock ends the build; the next seek starts it again.
        if (!isBusy(error))
          this.#logger?.warn(upkeepFields(error), "archive checkpoint build failed");
      })
      .finally(() => this.#building.delete(archiveId));
    this.#building.set(archiveId, build);
  }

  /** Stores the missing checkpoints, one small transaction each, stopping if the archive is pruned. */
  async #build(archiveId: string, projectId: string, head: number): Promise<void> {
    const archives = this.#storage.archives();
    const version = domainReducer.version;
    // The build has its own short budget for the lock waits of all its writes.
    const budget = { remaining: UPKEEP_WAIT_MS };
    // Let the response that started the build go out first.
    await yieldToEventLoop();
    const stored = new Set(archives.checkpointPositions(archiveId));
    const last = Math.floor(head / ARCHIVE_CHECKPOINT_INTERVAL) * ARCHIVE_CHECKPOINT_INTERVAL;
    let missing = 0;
    while (stored.has(missing + ARCHIVE_CHECKPOINT_INTERVAL))
      missing += ARCHIVE_CHECKPOINT_INTERVAL;
    if (missing >= last) return;
    // Resume from the latest trusted checkpoint below the first gap.
    const { state, base } = this.#nearest(archiveId, projectId, missing, stored, budget);
    const store = (at: ProjectState, position: number): boolean => {
      if (position % ARCHIVE_CHECKPOINT_INTERVAL !== 0 || stored.has(position)) return true;
      if (!archives.get(archiveId)) return false;
      return archives.putCheckpoint(
        archiveId,
        {
          sequence: position,
          reducerVersion: version,
          stateHash: stateHash(version, at),
          stateJson: canonicalJson(at),
        },
        budget,
      );
    };
    // Chunks of one interval from an aligned base end on a checkpoint position.
    await this.#replay(archiveId, state, base, last, ARCHIVE_CHECKPOINT_INTERVAL, store);
  }

  #attempt(fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (error) {
      if (!isBusy(error)) this.#logger?.warn(upkeepFields(error), "checkpoint cache upkeep failed");
      return false;
    }
  }
}
