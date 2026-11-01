import { useSyncExternalStore } from "react";
import { Anchored, AnchorLayer } from "../../overlays/host/index.ts";
import type { OverlayDefinition, OverlayProps } from "../../overlays/host/types.ts";
import styles from "./labels.module.css";
import { movementLabels } from "./labels.ts";

/** World anchor id of an agent's label point (above its head). The city publishes it. */
export const agentAnchorId = (id: string) => `agent:${id}`;

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
  return (
    <AnchorLayer source={anchors} gap={4} margin={48}>
      {rows.map((r) => (
        <Anchored key={r.id} id={r.id} anchorId={agentAnchorId(r.id)} priority={r.urgent ? 9 : 0}>
          <div
            className={styles.label}
            data-testid="agent-label"
            data-agent-id={r.id}
            data-state={r.state}
            data-urgent={r.urgent ? "true" : undefined}
          >
            <span className={styles.name}>{r.name}</span>
            <span className={styles.status}>{r.status}</span>
            {r.onTheWay && <span className={styles.onTheWay}>on the way</span>}
          </div>
        </Anchored>
      ))}
    </AnchorLayer>
  );
}

export const agentLabelsOverlay: OverlayDefinition = {
  id: "agent-labels",
  slot: "world-labels",
  modes: ["live", "history"],
  Component: AgentLabels,
};
