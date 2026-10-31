// Read-side selectors over ProjectState. Anything that depends on elapsed time takes an injected
// clock here and is never stored in reducer state.

export {
  type AttentionAgent,
  type AttentionCounts,
  type AttentionInput,
  type AttentionOptions,
  attention,
  attentionCounts,
  needsAttention,
  SILENT_THRESHOLD_MS,
} from "./attention.ts";
