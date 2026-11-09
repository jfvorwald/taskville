// Codex adapter (A1.01, docs/spikes/S-5-codex.md). The engine's source endpoint calls
// `mapCodexHook` with each raw hook payload.

export type { MapResult } from "../claude-code/core/index.ts";
export { requestIdFor, SOURCE_ID, sessionAgentId, subagentAgentId } from "./ids.ts";
export { type CodexHookContext, mapCodexHook, type OpenToolCall, stripNamespace } from "./map.ts";
