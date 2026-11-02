import { useMemo } from "react";
import type { Agent } from "../../../data/domain.ts";
import type { FamilyTeams } from "../shell/family.ts";
import styles from "./crew.module.css";
import { crewRows } from "./crewRows.ts";

export interface CrewTabProps {
  parentId: string;
  agents: Readonly<Record<string, Agent>>;
  activity: Readonly<Record<string, { activity: string } | undefined>>;
  results?: Readonly<Record<string, string>> | undefined;
  nowMs: number;
  teams?: FamilyTeams | undefined;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}

/** The Crew tab: the parent's direct children, finished ones collapsed to their result. */
export function CrewTab({
  parentId,
  agents,
  activity,
  results,
  nowMs,
  teams,
  onSelect,
  onHover,
}: CrewTabProps) {
  const rows = useMemo(
    () => crewRows({ parentId, agents, activity, results, nowMs, teams }),
    [parentId, agents, activity, results, nowMs, teams],
  );
  if (rows.length === 0) {
    return (
      <p className={styles.empty} data-testid="crew-empty">
        No crew yet.
      </p>
    );
  }
  return (
    <ul className={styles.list} data-testid="crew-list">
      {rows.map((row) => (
        <li
          key={row.id}
          className={styles.row}
          data-testid="crew-row"
          data-agent-id={row.id}
          data-status={row.status}
          data-collapsed={row.collapsed ? "true" : "false"}
        >
          <span className={styles.dot} data-testid="crew-row-dot" data-status={row.status} />
          <button
            type="button"
            className={styles.name}
            onClick={() => onSelect(row.id)}
            onPointerEnter={() => onHover(row.id)}
            onPointerLeave={() => onHover(null)}
            onFocus={() => onHover(row.id)}
            onBlur={() => onHover(null)}
          >
            {row.name}
          </button>
          <span className={styles.elapsed} data-testid="crew-row-elapsed">
            {row.elapsedLabel}
          </span>
          {row.activity === null ? null : (
            <span className={styles.activity} data-testid="crew-row-activity">
              {row.activity}
            </span>
          )}
          {row.summary === null ? null : (
            <span className={styles.summary} data-testid="crew-row-summary">
              {row.summary}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
