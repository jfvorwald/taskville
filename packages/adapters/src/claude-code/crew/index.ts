// Claude Code crew mapping: subagents and agent teams (M2.04, #23). See map.ts.
export {
  AGENT_ID_MAX,
  type Attribution,
  attributeHook,
  childAgentId,
  type HookRole,
  isTeammateAgentId,
  NAME_MAX,
  SESSION_ID_MAX,
  sessionAgentId,
} from "./attribution.ts";
export {
  CREW_HOOKS,
  type CrewContext,
  type CrewEvent,
  type CrewMapResult,
  mapCrewHook,
  SOURCE_ID,
} from "./map.ts";
