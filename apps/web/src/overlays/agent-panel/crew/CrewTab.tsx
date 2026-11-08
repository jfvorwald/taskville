import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "../../../data/domain.ts";
import type { FamilyTeams } from "../shell/family.ts";
import styles from "./crew.module.css";
import { type CrewActivity, type CrewStatus, crewRows } from "./crewRows.ts";

export interface CrewTabProps {
  parentId: string;
  agents: Readonly<Record<string, Agent>>;
  activity: Readonly<Record<string, CrewActivity | undefined>>;
  results?: Readonly<Record<string, string>> | undefined;
  nowMs: number;
  teams?: FamilyTeams | undefined;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}

const STATUS_TEXT: Record<CrewStatus, string> = {
  active: "Working",
  idle: "Idle",
  finished: "Finished",
  unknown: "Unknown",
};

/**
 * A finished child's result as plain text, clamped to two lines. The toggle only appears when
 * the text is longer than that, and it is a real button so the keyboard reaches it.
 */
function Result({ name, text }: { name: string; text: string }) {
  // Runs of blank lines would spend the two clamped lines on nothing.
  const shown = text.replace(/\n[ \t]*(?:\n[ \t]*)+/g, "\n");
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      if (!expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, shown]);
  return (
    <>
      <p
        ref={ref}
        className={styles.summary}
        data-testid="crew-row-summary"
        data-expanded={expanded ? "true" : "false"}
      >
        {shown}
      </p>
      {overflows || expanded ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Show less" : "Show more"} of ${name}'s result`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
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
          <span
            className={styles.dot}
            data-testid="crew-row-dot"
            data-status={row.status}
            role="img"
            aria-label={STATUS_TEXT[row.status]}
          />
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
          {row.summary === null ? null : <Result name={row.name} text={row.summary} />}
        </li>
      ))}
    </ul>
  );
}
