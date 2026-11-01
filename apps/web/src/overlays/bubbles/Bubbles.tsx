import { useEffect, useState } from "react";
import { agentAnchorId } from "../../city/movement/index.ts";
import { useData } from "../../data/react.ts";
import { dataStore } from "../../data/store.ts";
import { useTheme } from "../../themes/core/react.ts";
import { useReducedMotion } from "../../wiring/index.ts";
import { Anchored, AnchorLayer } from "../host/index.ts";
import type { OverlayDefinition, OverlayProps } from "../host/types.ts";
import styles from "./bubbles.module.css";
import { bubbleCandidates } from "./candidates.ts";
import { type Bubble, selectBubbles } from "./select.ts";

/** How often the open quip windows are re-checked. Bubbles last 4 s, so this is coarse enough. */
const TICK_MS = 500;

/** A bubble and the key that restarts its fade: the agent plus the event behind the line. */
interface Shown {
  key: string;
  bubble: Bubble;
}

const NONE: readonly Shown[] = [];

const same = (a: readonly Shown[], b: readonly Shown[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.key === b[i].key &&
      x.bubble.line === b[i].bubble.line &&
      x.bubble.fact === b[i].bubble.fact,
  );

/**
 * The bubbles to show now. Recomputed when attention changes and on a coarse timer while anything
 * needs attention; React re-renders only when the visible set actually changes.
 */
function useBubbles(selectedAgentId: string | null, theme: string): readonly Shown[] {
  const records = useData((s) => s.attention);
  const requests = useData((s) => s.state?.requests);
  const [bubbles, setBubbles] = useState(NONE);
  useEffect(() => {
    const update = () => {
      const now = dataStore.now();
      const candidates = bubbleCandidates(records, requests ?? {}, now);
      const eventIds = new Map(candidates.map((c) => [c.agentId, c.eventId]));
      const next = selectBubbles(candidates, { selectedAgentId, now, theme }).map((bubble) => ({
        key: `${bubble.agentId}:${eventIds.get(bubble.agentId)}`,
        bubble,
      }));
      setBubbles((prev) => (same(prev, next) ? prev : next));
    };
    update();
    if (records.length === 0) return;
    const timer = setInterval(update, TICK_MS);
    return () => clearInterval(timer);
  }, [records, requests, selectedAgentId, theme]);
  return bubbles;
}

/**
 * Speech bubbles over agents that are stuck: a themed one-liner, plus the tool name for a
 * permission wait. Text is always a React text child.
 */
export function Bubbles({ anchors, selection }: OverlayProps) {
  const theme = useTheme((s) => s.themeId);
  const reducedMotion = useReducedMotion();
  const bubbles = useBubbles(selection.selectedId, theme);
  return (
    <AnchorLayer source={anchors} gap={4} margin={48}>
      {bubbles.map(({ key, bubble: b }) => (
        <Anchored
          key={key}
          id={`bubble:${key}`}
          anchorId={agentAnchorId(b.agentId)}
          priority={b.level === "needs_you" ? 8 : 4}
        >
          <div
            className={styles.bubble}
            data-testid="quip-bubble"
            data-agent-id={b.agentId}
            data-level={b.level}
            data-reduced-motion={reducedMotion ? "true" : undefined}
          >
            <span className={styles.line}>{b.line}</span>
            {b.fact !== null && <span className={styles.fact}>{b.fact}</span>}
          </div>
        </Anchored>
      ))}
    </AnchorLayer>
  );
}

export const bubblesOverlay: OverlayDefinition = {
  id: "bubbles",
  slot: "bubbles",
  modes: ["live"],
  Component: Bubbles,
};
