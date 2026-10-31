// Claude Code crew mapping: subagents and agent teams (M2.04, #23). See map.ts.
export {
  type Attribution,
  attributeHook,
  type HookRole,
  isTeammateAgentId,
  NAME_MAX,
} from "./attribution.ts";
export {
  type CrewContext,
  type CrewEvent,
  type CrewMapResult,
  mapCrewHook,
} from "./map.ts";
