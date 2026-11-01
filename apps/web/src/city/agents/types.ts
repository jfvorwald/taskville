// What the block agents need to know about one agent. The store is wired in by the lead
// (M3.02 data layer, M3.06 navigation), so these are plain structural types defined here; the
// domain's `Agent`, activity and attention records map onto them with a small selector.

export type AgentKindView = "session" | "subagent" | "lead" | "teammate" | "unknown";

export type ActivityView =
  | "idle"
  | "implementing"
  | "testing"
  | "reviewing"
  | "researching"
  | "documenting"
  | "dispatching"
  | "handing_off"
  | "waiting"
  | "unknown";

export type AttentionLevelView = "needs_you" | "trouble" | "waiting";

export interface AttentionView {
  readonly level: AttentionLevelView;
  /** Short selector text such as "quiet for 12 min". Shown after "Trouble:". */
  readonly detail?: string;
  /** True for guesses (silent trouble). The label says so through `detail`. */
  readonly heuristic?: boolean;
  /** The domain attention kind (such as "permission" or "silent"); picks the emote. */
  readonly kind?: string;
  /** When the record began, epoch milliseconds; the pulse runs on the time since. */
  readonly sinceMs?: number;
}

/**
 * Where the agent stands. Navigation (M3.06) owns the numbers and may mutate this object in
 * place every frame; the agents read it each frame and copy nothing, so nothing is allocated.
 */
export interface Placement {
  x: number;
  y: number;
  z: number;
  /** Rotation about the vertical axis, radians. */
  heading: number;
}

export interface AgentView {
  readonly id: string;
  readonly kind: AgentKindView;
  readonly displayName?: string;
  /** Source identity; with `sourceId` it is the agent's identity (never merged on names). */
  readonly sourceId?: string;
  readonly sourceAgentId?: string;
  /** `subagent` only: the `agent_type` the body color comes from. */
  readonly agentType?: string;
  /** `subagent` only: the parent's identity key (see `identityKey`), source of the trim color. */
  readonly parentIdentity?: string;
  /** `teammate` and `lead`: the shared scarf color comes from the team. */
  readonly teamId?: string;
  /** Subagent generation: 0 for a top-level agent, 1 for its subagent, and so on. */
  readonly depth?: number;
  readonly activity: ActivityView;
  readonly attention?: AttentionView;
  readonly placement: Placement;
}

/** A screen-independent anchor for the world-labels slot (M3.03 owns the slot). */
export interface AgentLabelEntry {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  /** World position just above the head; read when the slot projects it. */
  readonly anchor: Placement;
  /** Height above `anchor.y` in world units, scaled with the agent. */
  readonly offsetY: number;
}
