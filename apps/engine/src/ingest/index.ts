// Engine ingest: validate, normalize, dedupe, sequence, and commit event batches
// (ARCHITECTURE.md 7.2, specs/001 FR-001 to FR-004, FR-011, FR-017).
export { normalizePayload, stripControlCharacters } from "./normalize.ts";
export {
  type CommittedBatch,
  domainReducer,
  type IngestOptions,
  IngestPipeline,
} from "./pipeline.ts";
export { registerIngestRoute } from "./route.ts";
