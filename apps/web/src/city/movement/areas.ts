import type { ActivityView, AgentKindView } from "../agents/types.ts";
import { AREA_IDS, type AreaId } from "../layout/index.ts";

// Activity to work area (ARCHITECTURE.md 8.3). Work areas are presentation destinations, not
// workflow stages, and the table is data so users can change it: `resolveActivityAreas` merges a
// config object (for example parsed JSON) over the defaults and drops anything it cannot use.

/** A subagent whose `agent_type` contains `match` (case-insensitive) goes to `area`. */
export interface AgentTypeRule {
  readonly match: string;
  readonly area: AreaId;
}

export interface ActivityAreaTable {
  /** `null`: the activity names no destination, so the agent keeps the one it has. */
  readonly activities: Readonly<Record<ActivityView, AreaId | null>>;
  /** Checked in order before the activity, for subagents only. */
  readonly agentTypes: readonly AgentTypeRule[];
}

const ACTIVITY_KEYS: readonly ActivityView[] = [
  "idle",
  "implementing",
  "testing",
  "reviewing",
  "researching",
  "documenting",
  "dispatching",
  "handing_off",
  "waiting",
  "unknown",
];

export const DEFAULT_ACTIVITY_AREAS: ActivityAreaTable = Object.freeze({
  activities: Object.freeze({
    idle: null,
    implementing: "workshop",
    testing: "test_lab",
    reviewing: "review",
    researching: "archives",
    documenting: "archives",
    dispatching: "dispatch",
    handing_off: null,
    waiting: null,
    unknown: null,
  }),
  // Security first: a "security-reviewer" is a security-type subagent, not a reviewer.
  agentTypes: Object.freeze([
    Object.freeze({ match: "security", area: "security" }),
    Object.freeze({ match: "review", area: "review" }),
  ]),
} as const);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isArea = (v: unknown): v is AreaId =>
  typeof v === "string" && (AREA_IDS as readonly string[]).includes(v);

/**
 * The defaults with `overrides` applied. Shape: `{ activities?: { <activity>: <area id> | null },
 * agentTypes?: [{ match, area }] }`. A given `agentTypes` list replaces the default rules.
 * Unknown activities, unknown areas and malformed rules are ignored.
 */
export function resolveActivityAreas(overrides: unknown): ActivityAreaTable {
  if (!isRecord(overrides)) return DEFAULT_ACTIVITY_AREAS;
  const activities: Record<ActivityView, AreaId | null> = { ...DEFAULT_ACTIVITY_AREAS.activities };
  if (isRecord(overrides.activities)) {
    for (const key of ACTIVITY_KEYS) {
      if (!Object.hasOwn(overrides.activities, key)) continue;
      const value = overrides.activities[key];
      if (value === null || isArea(value)) activities[key] = value;
    }
  }
  let agentTypes = DEFAULT_ACTIVITY_AREAS.agentTypes;
  if (Array.isArray(overrides.agentTypes)) {
    agentTypes = overrides.agentTypes.flatMap((rule: unknown) =>
      isRecord(rule) && typeof rule.match === "string" && rule.match !== "" && isArea(rule.area)
        ? [{ match: rule.match, area: rule.area }]
        : [],
    );
  }
  return { activities, agentTypes };
}

export interface AreaQuery {
  readonly activity: ActivityView;
  /** A subagent's `agent_type` (the domain agent's `role`). */
  readonly agentType?: string | undefined;
  /** When given and not `subagent`, `agentType` is not consulted. */
  readonly kind?: AgentKindView | undefined;
}

/** Where an agent doing `activity` should be, or null when the activity names no place. */
export function areaFor(table: ActivityAreaTable, q: AreaQuery): AreaId | null {
  if (q.agentType !== undefined && (q.kind === undefined || q.kind === "subagent")) {
    const type = q.agentType.toLowerCase();
    for (const rule of table.agentTypes) {
      if (type.includes(rule.match.toLowerCase())) return rule.area;
    }
  }
  return table.activities[q.activity] ?? null;
}
