import { useSyncExternalStore } from "react";
import { Anchored, AnchorLayer } from "../../overlays/host/index.ts";
import type { OverlayDefinition, OverlayProps } from "../../overlays/host/types.ts";
import { getSettingsStore } from "../../overlays/settings/store.ts";
import { breakNote } from "../agents/label.ts";
import { FileScreen } from "../crew/file-screen/FileScreen.tsx";
import { fileScreenStore } from "../crew/file-screen/fileScreenStore.ts";
import { agentAnchorId } from "./anchorId.ts";
import styles from "./labels.module.css";
import { movementLabels } from "./labels.ts";

export { agentAnchorId };

/**
 * Agent name tags in the world-labels slot. The status is the recorded state, shown at once even
 * while the bot is still walking; a walking bot adds a small "on the way" mark.
 */
export function AgentLabels({ anchors }: OverlayProps) {
  const rows = useSyncExternalStore(
    movementLabels.subscribe,
    movementLabels.getSnapshot,
    movementLabels.getSnapshot,
  );
  const settings = getSettingsStore();
  const { breakTime } = useSyncExternalStore(
    settings.subscribe,
    settings.getSnapshot,
    settings.getSnapshot,
  );
  const screen = useSyncExternalStore(
    fileScreenStore.subscribe,
    fileScreenStore.getSnapshot,
    fileScreenStore.getSnapshot,
  );
  return (
    <AnchorLayer source={anchors} gap={4} margin={48}>
      {rows
        .filter((r) => r.kind === undefined)
        .map((r) => {
          const note = breakTime ? breakNote(r.status, r.onBreak === true) : null;
          return (
            <Anchored
              key={r.id}
              id={r.id}
              anchorId={agentAnchorId(r.id)}
              priority={r.urgent ? 9 : 0}
            >
              <div
                className={styles.label}
                data-testid="agent-label"
                data-agent-id={r.id}
                data-state={r.state}
                data-urgent={r.urgent ? "true" : undefined}
              >
                <span className={styles.name}>{r.name}</span>
                <span className={styles.status}>{r.status}</span>
                {note !== null && (
                  <span className={styles.onTheWay} data-testid="agent-label-on-break">
                    {note}
                  </span>
                )}
                {r.onTheWay && <span className={styles.onTheWay}>on the way</span>}
              </div>
            </Anchored>
          );
        })}
      <FileScreen agentId={screen.agentId} path={screen.path} />
    </AnchorLayer>
  );
}

export const agentLabelsOverlay: OverlayDefinition = {
  id: "agent-labels",
  slot: "world-labels",
  modes: ["live", "history"],
  Component: AgentLabels,
};
