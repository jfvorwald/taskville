// Engine storage: SQLite event log, projects, projections, and pairings
// (ARCHITECTURE.md 7.4, specs/001 data-model.md).
export { StorageError } from "./errors.ts";
export { LATEST_SCHEMA_VERSION } from "./migrations.ts";
export { SqlitePairingRecords } from "./pairings.ts";
export { type ProjectionReducer, rebuildProjection, rebuildStaleProjections } from "./rebuild.ts";
export {
  type NewProject,
  openStorage,
  type ProjectionRecord,
  type ProjectionWrite,
  type ProjectRecord,
  Storage,
  type StorageOptions,
  type StorageReads,
  type StorageTransaction,
  type StoredEventRecord,
} from "./storage.ts";
export {
  clientContentHash,
  ENGINE_SOURCE_ID,
  type EnsureUnsortedOptions,
  ensureUnsortedProject,
  UNSORTED_PROJECT_ID,
  UNSORTED_PROJECT_NAME,
} from "./unsorted.ts";
