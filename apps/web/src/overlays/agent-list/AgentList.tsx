import { useMemo, useSyncExternalStore } from "react";
import { GridList, GridListItem } from "react-aria-components";
import { TeamTaskQueue } from "../../city/crew/teams/TeamTaskQueue.tsx";
import { movementLabels } from "../../city/movement/labels.ts";
import { InteractiveRegion } from "../host/InteractiveRegion.tsx";
import type { OverlayDefinition, OverlayProps } from "../host/types.ts";
import styles from "./agent-list.module.css";
import { agentListRows } from "./rows.ts";

/**
 * The scene's agents as a list for keyboard and screen reader users. One tab stop, arrows move
 * between rows, Enter selects the agent in the city, and the selected row is aria-selected. It reads the same rows as the world labels.
 */
export function AgentList({ selection }: OverlayProps) {
  const labels = useSyncExternalStore(
    movementLabels.subscribe,
    movementLabels.getSnapshot,
    movementLabels.getSnapshot,
  );
  const rows = useMemo(() => agentListRows(labels), [labels]);
  const selectedId = selection.selectedId;
  const selectedKeys = useMemo(() => (selectedId === null ? [] : [selectedId]), [selectedId]);
  return (
    <InteractiveRegion className={styles.panel}>
      <GridList
        aria-label="Agents"
        data-testid="agent-list"
        className={styles.list}
        selectionMode="single"
        selectionBehavior="toggle"
        selectedKeys={selectedKeys}
        onSelectionChange={(keys) => {
          // Emptying the set (clicking the selected row again) must not clear the city selection.
          const [key] = keys === "all" ? [] : keys;
          if (key !== undefined) selection.select(String(key));
        }}
        onAction={(key) => selection.select(String(key))}
        items={rows}
        renderEmptyState={() => <p className={styles.empty}>No agents yet</p>}
      >
        {(row) => (
          <GridListItem
            id={row.id}
            textValue={row.description}
            className={styles.row}
            data-agent-id={row.id}
            data-urgent={row.urgent ? "true" : undefined}
          >
            <span className={styles.name}>{row.name}</span>
            <span className={styles.status}>{row.detail}</span>
          </GridListItem>
        )}
      </GridList>
      <div className={styles.queues}>
        <TeamTaskQueue />
      </div>
    </InteractiveRegion>
  );
}

export const agentListOverlay: OverlayDefinition = {
  id: "agent-list",
  slot: "timeline",
  modes: ["live", "history"],
  Component: AgentList,
};
