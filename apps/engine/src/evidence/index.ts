// Evidence store (ARCHITECTURE.md 7.4): redacted, capped tool call bodies in
// `evidence.db`, keyed by content hash, with ToolCall pointers that outlive eviction.
export { MAX_BODY_BYTES, type PreparedBody, prepareBody, TRUNCATION_MARKER } from "./body.ts";
export {
  type BodyPart,
  DEFAULT_CAP_BYTES,
  EVICTED_MESSAGE,
  type EvidenceBody,
  EvidenceStore,
  type EvidenceStoreOptions,
  openEvidenceStore,
  type ToolCallEvidence,
} from "./store.ts";
