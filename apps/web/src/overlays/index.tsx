import { useMemo, useState } from "react";
import { countsHeaderOverlay } from "./header/index.ts";
import {
  createOverlayRegistry,
  OverlayHost,
  type OverlaySelectors,
  worldAnchors,
} from "./host/index.ts";
import styles from "./overlays.module.css";

/**
 * Every bundled overlay. A later ticket adds its definition here (one import, one array entry)
 * and, to show it, its id to `ENABLED` until presets (Ambient, Operations, History) own that.
 */
const registry = createOverlayRegistry([countsHeaderOverlay]);
const ENABLED = ["counts-header"];

/** Placeholder until the M3.02 store is wired in: swap for selectors over the real store. */
const selectors: OverlaySelectors = (() => {
  const counts = { active: 0, needsYou: 0 };
  return { counts: { subscribe: () => () => {}, getSnapshot: () => counts } };
})();

const noIntent = () => {};

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The DOM layer over the canvas: the overlay host plus the paired badge. `pointer-events: none`
 * on the layer lets the canvas keep the pointer; an overlay that needs it uses InteractiveRegion.
 */
export function OverlayRoot() {
  const [selectedId, select] = useState<string | null>(null);
  const selection = useMemo(() => ({ selectedId, select }), [selectedId]);
  const storage = useMemo(localStorageOrNull, []);
  return (
    <div className={styles.layer} data-testid="overlay-root">
      <OverlayHost
        registry={registry}
        enabled={ENABLED}
        mode="live"
        selectors={selectors}
        selection={selection}
        anchors={worldAnchors}
        runIntent={noIntent}
        storage={storage}
      />
      <p className={styles.badge}>Taskville · paired</p>
    </div>
  );
}
