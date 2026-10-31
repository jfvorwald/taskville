// Core Claude Code hook mapper (M2.03). See map.ts.
export { activityForTool, looksLikeTestRun, type ToolActivity } from "./activity.ts";
export { type Attribution, attributeHook } from "./attribution.ts";
export {
  isHookId,
  MAX_AGENT_ID,
  MAX_SESSION_ID,
  MAX_SOURCE_EVENT_ID,
  MAX_TOOL_USE_ID,
  requestIdFor,
  SOURCE_ID,
  sessionAgentId,
  subagentAgentId,
} from "./ids.ts";
export { CREW_HOOKS, mapCoreHook } from "./map.ts";
export type { HookContext, HookSubject, MapResult, ToolEvidence } from "./types.ts";
