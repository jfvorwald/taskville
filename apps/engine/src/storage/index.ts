// Engine storage: SQLite event log, projects, projections, and pairings
// (ARCHITECTURE.md 7.4, specs/001 data-model.md).
export { StorageError } from "./errors.ts";
export { LATEST_SCHEMA_VERSION } from "./migrations.ts";
export { SqlitePairingRecords } from "./pairings.ts";
export { type ProjectionReducer, rebuildProjection, rebuildStaleProjections } from "./rebuild.ts";
export {
  JOURNAL_SIZE_LIMIT_BYTES,
  type NewProject,
  openStorage,
  PAGE_CACHE_KIB,
  type ProjectionMeta,
  type ProjectionRecord,
  type ProjectionWrite,
  type ProjectRecord,
  Storage,
  type StorageOptions,
  type StoragePragma,
  type StorageReads,
  type StorageTransaction,
  type StoredEventRecord,
  WAL_AUTOCHECKPOINT_PAGES,
} from "./storage.ts";
export {
  clientContentHash,
  ENGINE_SOURCE_ID,
  type EnsureUnsortedOptions,
  ensureUnsortedProject,
  UNSORTED_PROJECT_ID,
  UNSORTED_PROJECT_NAME,
} from "./unsorted.ts";
