import { useEffect, useMemo } from "react";
import { cameraControlsOverlay, useSelection } from "../city/interaction/index.ts";
import { selectionStore } from "../city/interaction/selection.ts";
import { agentLabelsOverlay, countsSelector } from "../city/movement/index.ts";
import { projectSelection, useCurrentProjectId } from "../data/project.ts";
import { useData, useDataSync } from "../data/react.ts";
import { dataStore } from "../data/store.ts";
import { themedSettingsOverlay } from "../wiring/index.ts";
import { agentListOverlay } from "./agent-list/index.ts";
import { bubblesOverlay } from "./bubbles/index.ts";
import {
  countsHeaderOverlay,
  useAttentionSync,
  useAttentionTabTitle,
  useDesktopNotifications,
} from "./header/index.ts";
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
  agentListOverlay,
  bubblesOverlay,
]);
const ENABLED = [
  "counts-header",
  "agent-labels",
  "camera-controls",
  "settings-panel",
  "agent-list",
  "bubbles",
];

const selectors: OverlaySelectors = { counts: countsSelector(dataStore) };

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
  useDataSync(useCurrentProjectId());
  // The selected agent belongs to the project that was shown; it is not in the next one.
  useEffect(
    () =>
      projectSelection.subscribe((state, before) => {
        if (state.projectId !== before.projectId) selectionStore.select(null);
      }),
    [],
  );
  useAttentionSync();
  useAttentionTabTitle();
  useDesktopNotifications();
  const connection = useData((s) => s.connection);
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
      <p className={styles.badge}>
        {connection === "stale" ? "Taskville · stale" : "Taskville · paired"}
      </p>
    </div>
  );
}
