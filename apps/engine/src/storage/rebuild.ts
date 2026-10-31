import type { StoredEnvelope } from "@taskville/protocol";
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
  return storage.transaction((tx) => {
    let state = reducer.initial(projectId);
    let head = 0;
    for (const event of tx.events(projectId)) {
      state = reducer.apply(state, event);
      head = event.ingestSequence;
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
 * the project head. Returns the IDs it rebuilt.
 */
export function rebuildStaleProjections<S>(
  storage: Storage,
  reducer: ProjectionReducer<S>,
): string[] {
  const rebuilt: string[] = [];
  for (const project of storage.projects()) {
    const projection = storage.projection(project.id);
    const fresh =
      projection !== undefined &&
      projection.reducerVersion === reducer.version &&
      projection.head === project.head;
    if (fresh) continue;
    rebuildProjection(storage, project.id, reducer);
    rebuilt.push(project.id);
  }
  return rebuilt;
}
