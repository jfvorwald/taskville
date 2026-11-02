import type { Agent } from "../../../data/domain.ts";
import { elapsedMs, formatElapsed } from "../shell/facts.ts";
import { type FamilyTeams, familyOrder, familyPath } from "../shell/family.ts";

const ID_SHORT = 8;
const NOT_REPORTED = "not reported";

export type CrewStatus = "active" | "idle" | "unknown" | "finished";

/** A recorded activity; a heuristic one is a guess (constitution IV). */
export interface CrewActivity {
  activity: string;
  heuristic?: boolean | undefined;
}

export interface CrewRow {
  id: string;
  name: string;
  status: CrewStatus;
  activity: string | null;
  elapsedMs: number | null;
  elapsedLabel: string;
  summary: string | null;
  collapsed: boolean;
}

export interface CrewRowsInput {
  parentId: string;
  agents: Readonly<Record<string, Agent>>;
  activity: Readonly<Record<string, CrewActivity | undefined>>;
  /** The recorded result summary of a finished agent, by agent id. */
  results?: Readonly<Record<string, string>> | undefined;
  nowMs: number;
  teams?: FamilyTeams | undefined;
}

/** "handing_off" is read as "Handing off", the same words the world labels use. */
function activityText(activity: string): string {
  const words = activity.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function nameOf(agent: Agent): string {
  const name = agent.displayName;
  return name !== undefined && name.trim() !== ""
    ? name
    : Array.from(agent.id).slice(0, ID_SHORT).join("");
}

/** The ids of the agent's direct children, in family order (registration, then id). */
export function childIdsOf(
  parentId: string,
  agents: Readonly<Record<string, Agent>>,
  teams?: FamilyTeams,
): string[] {
  const list = Object.values(agents);
  return familyOrder(parentId, list, teams).filter(
    (id) => id !== parentId && familyPath(id, list, teams).at(-2) === parentId,
  );
}

/** The parent's direct children, unfinished first, then finished; each group in family order. */
export function crewRows({
  parentId,
  agents,
  activity,
  results,
  nowMs,
  teams,
}: CrewRowsInput): CrewRow[] {
  const rows = childIdsOf(parentId, agents, teams).flatMap((id): CrewRow[] => {
    const agent = agents[id];
    if (agent === undefined) return [];
    const finished = agent.finishedAt !== undefined;
    const entry = Object.hasOwn(activity, id) ? activity[id] : undefined;
    const current = entry?.activity;
    const status: CrewStatus = finished
      ? "finished"
      : current === undefined || current === "unknown"
        ? "unknown"
        : current === "idle"
          ? "idle"
          : "active";
    const label =
      current === undefined
        ? null
        : entry?.heuristic === true && current !== "unknown"
          ? `Possibly ${activityText(current).toLowerCase()}`
          : activityText(current);
    const elapsed = elapsedMs(agent, nowMs);
    const result = results !== undefined && Object.hasOwn(results, id) ? results[id] : undefined;
    return [
      {
        id,
        name: nameOf(agent),
        status,
        activity: finished ? null : label,
        elapsedMs: elapsed,
        elapsedLabel: elapsed === null ? "" : formatElapsed(elapsed),
        summary: finished ? (result ?? NOT_REPORTED) : null,
        collapsed: finished,
      },
    ];
  });
  return [...rows.filter((r) => !r.collapsed), ...rows.filter((r) => r.collapsed)];
}
