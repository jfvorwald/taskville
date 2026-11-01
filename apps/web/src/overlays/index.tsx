import { useEffect, useMemo } from "react";
import { useSoundscape } from "../audio/index.ts";
import { cameraControlsOverlay, useSelection } from "../city/interaction/index.ts";
import { selectionStore } from "../city/interaction/selection.ts";
import { agentLabelsOverlay, countsSelector } from "../city/movement/index.ts";
import { projectSelection, useCurrentProjectId } from "../data/project.ts";
import { useData, useDataSync } from "../data/react.ts";
import { type DataStore, dataStore } from "../data/store.ts";
import {
  PresentedSidebar,
  presentedActionCardOverlay,
  presentedAgentListOverlay,
  presentedAgentPanelOverlay,
  useRecordedTarget,
} from "../history/ui/PresentedSidebar.tsx";
import { themedSettingsOverlay } from "../wiring/index.ts";
import { ACTION_CARD_ID, useCardTarget } from "./action-card/index.ts";
import { AGENT_PANEL_ID } from "./agent-panel/shell/index.ts";
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
import { SETTINGS_OVERLAY_ID } from "./settings/index.ts";

/**
 * Every bundled overlay. A later ticket adds its definition here (one import, one array entry)
 * and, to show it, its id to `ENABLED` until presets (Ambient, Operations, History) own that.
 */
const registry = createOverlayRegistry([
  countsHeaderOverlay,
  agentLabelsOverlay,
  cameraControlsOverlay,
  themedSettingsOverlay,
  presentedAgentListOverlay,
  bubblesOverlay,
  presentedAgentPanelOverlay,
  presentedActionCardOverlay,
]);
const ENABLED = [
  "counts-header",
  "agent-labels",
  "camera-controls",
  "settings-panel",
  "agent-list",
  "bubbles",
  AGENT_PANEL_ID,
  ACTION_CARD_ID,
];

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
export function OverlayRoot({
  store = dataStore,
  mode = "live",
}: {
  store?: DataStore;
  mode?: "live" | "history";
}) {
  const selectors: OverlaySelectors = useMemo(() => ({ counts: countsSelector(store) }), [store]);
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
  useSoundscape();
  const connection = useData((s) => s.connection);
  const selection = useSelection();
  const agents = useData((s) => s.state?.agents, store);
  const selectedAgent =
    selection.selectedId !== null &&
    agents !== undefined &&
    Object.hasOwn(agents, selection.selectedId);
  // The live card is the app's own store; it is not asked while a recording is shown, so replay
  // facts never become the remembered target.
  const liveCard = useCardTarget(dataStore, mode === "live" ? selection.selectedId : null) !== null;
  const recordedTarget = useRecordedTarget(store, mode, selection.selectedId);
  // Needs-you takes the single sidebar ahead of the selected agent and settings.
  const cardOpen = mode === "history" ? (recordedTarget ?? null) !== null : liveCard;
  const sidebar = cardOpen ? ACTION_CARD_ID : selectedAgent ? AGENT_PANEL_ID : SETTINGS_OVERLAY_ID;
  const storage = useMemo(localStorageOrNull, []);
  return (
    <div className={styles.layer} data-testid="overlay-root">
      <PresentedSidebar store={store} recordedTarget={recordedTarget}>
        <OverlayHost
          registry={registry}
          enabled={ENABLED}
          sidebar={sidebar}
          mode={mode}
          selectors={selectors}
          selection={selection}
          anchors={worldAnchors}
          runIntent={noIntent}
          storage={storage}
        />
      </PresentedSidebar>
      <p className={styles.badge}>
        {connection === "stale" ? "Taskville · stale" : "Taskville · paired"}
      </p>
    </div>
  );
}
