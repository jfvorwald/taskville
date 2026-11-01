// The one place the web app reaches into the shared packages.
//
// `apps/web/package.json` does not yet declare `@taskville/domain` or `@taskville/protocol`
// (shared files are off limits to M3.02), so these re-exports use relative paths. When the
// dependencies are added, replace each path with its package export (`@taskville/domain/reducer`,
// `@taskville/domain/selectors`, `@taskville/protocol`) here; nothing else changes.

export {
  type Agent,
  initialState,
  type ProjectState,
  projectStateHash,
  REDUCER_VERSION,
  reduce,
} from "../../../../packages/domain/src/reducer/index.ts";
export {
  type AttentionCounts,
  attention,
  attentionCounts,
  SILENT_THRESHOLD_MS,
} from "../../../../packages/domain/src/selectors/index.ts";
export {
  type Attention,
  type SnapshotResponse,
  type SseFrame,
  type StoredEnvelope,
  snapshotResponseSchema,
  sseFrameSchema,
} from "../../../../packages/protocol/src/index.ts";
