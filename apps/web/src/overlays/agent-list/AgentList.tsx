import { useMemo, useSyncExternalStore } from "react";
import { Button, GridList, GridListItem } from "react-aria-components";
import { TeamTaskQueue } from "../../city/crew/teams/TeamTaskQueue.tsx";
import { movementLabels } from "../../city/movement/labels.ts";
import type { DataStore } from "../../data/store.ts";
import { InteractiveRegion } from "../host/InteractiveRegion.tsx";
import type { OverlayDefinition, OverlayProps } from "../host/types.ts";
import styles from "./agent-list.module.css";
import { agentListRows } from "./rows.ts";

const GUIDE_URL = "https://github.com/jfvorwald/taskville#try-it";

function Command({ command }: { command: string }) {
  return (
    <span className={styles.command}>
      <code>{command}</code>
      <Button
        className={styles.copy}
        aria-label={`Copy ${command}`}
        onPress={() => void navigator.clipboard?.writeText(command)}
      >
        Copy
      </Button>
    </span>
  );
}

function EmptyGuidance() {
  return (
    <section className={styles.guidance} aria-label="Get agents">
      <p>
        To see the city at work, run <Command command="taskville demo" />
      </p>
      <p>
        <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
          User guide
        </a>
      </p>
      <p>
        To watch your Claude Code sessions, run <Command command="taskville init" /> in your
        repository.
      </p>
    </section>
  );
}

/**
 * The scene's agents as a list for keyboard and screen reader users. One tab stop, arrows move
 * between rows, Enter selects the agent in the city, and the selected row is aria-selected. It reads the same rows as the world labels.
 */
export function AgentList({ mode, selection, store }: OverlayProps & { store?: DataStore }) {
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
        renderEmptyState={() =>
          mode === "live" ? <EmptyGuidance /> : <p className={styles.empty}>No agents yet</p>
        }
      >
        {(row) => (
          <GridListItem
            id={row.id}
            textValue={row.description}
            className={styles.row}
            data-agent-id={row.id}
            data-urgent={row.urgent ? "true" : undefined}
          >
            <span className={styles.name}>
              {row.name}
              {row.kind !== undefined && <span className={styles.kind}> {row.kind}</span>}
            </span>
            <span className={styles.status}>{row.detail}</span>
          </GridListItem>
        )}
      </GridList>
      <div className={styles.queues}>
        <TeamTaskQueue {...(store === undefined ? {} : { store })} />
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
