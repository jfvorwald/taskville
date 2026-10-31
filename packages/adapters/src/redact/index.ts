// Secret redaction (ARCHITECTURE.md sections 2.4, 2.10, 13; spec 001 FR-017).
// Pure and deterministic: no I/O, clock, or randomness, so a retried event masks
// to the same text and still matches as a duplicate.
export {
  type JsonMask,
  type JsonPath,
  type JsonValue,
  type RedactedJson,
  type RedactJsonOptions,
  redactJson,
} from "./json.ts";
export { type MaskKind, maskMarker } from "./rules.ts";
export { type MaskSpan, type RedactedText, redactText } from "./text.ts";
