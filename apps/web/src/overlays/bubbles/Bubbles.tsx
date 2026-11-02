import { useEffect, useState } from "react";
import { agentAnchorId } from "../../city/movement/index.ts";
import { useData } from "../../data/react.ts";
import { type DataStore, dataStore } from "../../data/store.ts";
import { useTheme } from "../../themes/core/react.ts";
import { useReducedMotion } from "../../wiring/index.ts";
import { Anchored, AnchorLayer } from "../host/index.ts";
import type { AnchorSource, OverlayDefinition, OverlayProps } from "../host/types.ts";
import styles from "./bubbles.module.css";
import { bubbleCandidates } from "./candidates.ts";
import { type Bubble, selectBubbles } from "./select.ts";

/** How often the open quip windows are re-checked. Bubbles last 4 s, so this is coarse enough. */
const TICK_MS = 500;

/** How long after the anchors change before the visible set is re-checked (not per frame). */
const ANCHOR_SETTLE_MS = 100;

/** The same margin the layer uses, so "visible" here is what the layer would show. */
const ANCHOR_MARGIN = 48;

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
function useBubbles(
  anchors: AnchorSource,
  selectedAgentId: string | null,
  theme: string,
  store: DataStore,
): readonly Shown[] {
  const records = useData((s) => s.attention, store);
  const requests = useData((s) => s.state?.requests, store);
  const [bubbles, setBubbles] = useState(NONE);
  useEffect(() => {
    const update = () => {
      const now = store.now();
      // Agents the layer would hide must not use up one of the three bubbles.
      const candidates = bubbleCandidates(records, requests ?? {}, now, selectedAgentId).filter(
        (c) =>
          anchors.project(agentAnchorId(c.agentId), { margin: ANCHOR_MARGIN })?.visible === true,
      );
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
    // The camera writes the anchors every frame; settle them into one re-check instead.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = anchors.subscribe(() => {
      settle ??= setTimeout(() => {
        settle = undefined;
        update();
      }, ANCHOR_SETTLE_MS);
    });
    return () => {
      clearInterval(timer);
      clearTimeout(settle);
      unsubscribe();
    };
  }, [anchors, records, requests, selectedAgentId, theme, store]);
  return bubbles;
}

/**
 * Speech bubbles over agents that are stuck: a themed one-liner, plus the tool name for a
 * permission wait. Text is always a React text child.
 */
export function Bubbles({
  anchors,
  selection,
  store = dataStore,
}: OverlayProps & { store?: DataStore }) {
  const theme = useTheme((s) => s.themeId);
  const reducedMotion = useReducedMotion();
  const bubbles = useBubbles(anchors, selection.selectedId, theme, store);
  return (
    <AnchorLayer source={anchors} gap={4} margin={ANCHOR_MARGIN}>
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
  modes: ["live", "history"],
  Component: Bubbles,
};
