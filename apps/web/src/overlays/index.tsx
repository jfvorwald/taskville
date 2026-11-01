import { useMemo } from "react";
import { cameraControlsOverlay, useSelection } from "../city/interaction/index.ts";
import { agentLabelsOverlay, countsSelector } from "../city/movement/index.ts";
import { useDataSync } from "../data/react.ts";
import { dataStore } from "../data/store.ts";
import { themedSettingsOverlay } from "../wiring/index.ts";
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
const registry = createOverlayRegistry([
  countsHeaderOverlay,
  agentLabelsOverlay,
  cameraControlsOverlay,
  themedSettingsOverlay,
]);
const ENABLED = ["counts-header", "agent-labels", "camera-controls", "settings-panel"];

const selectors: OverlaySelectors = { counts: countsSelector(dataStore) };

/** The project the city shows until project selection exists: the engine's built-in one. */
const PROJECT_ID = "unsorted";

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
  useDataSync(PROJECT_ID);
  const selection = useSelection();
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
