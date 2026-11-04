export { CREW_INDIVIDUAL_LIMIT, collapseCrew, crewMarkerLabel, FAN_OUT_MS } from "./crew.ts";
export { MAX_BOT_GENERATION, splitByGeneration, subagentScale } from "./generation.ts";
export {
  FADE_MS,
  HAND_OVER_MS,
  initialLifecycle,
  observeSubagent,
  parentIsWaiting,
  RETURN_MS,
  type SubagentFrame,
  type SubagentPhase,
  subagentFrame,
  WALK_OUT_MS,
} from "./lifecycle.ts";
export { disposeCrewResources } from "./resources.ts";
export { SubagentCrew, type SubagentCrewProps } from "./SubagentCrew.tsx";
