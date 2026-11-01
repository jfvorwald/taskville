import { useEffect, useMemo, useState } from "react";
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
import {
  SETTINGS_OVERLAY_ID,
  SettingsOpenContext,
  SettingsToggle,
  useKeepToggleFocus,
} from "./settings/index.ts";

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
  // The live card is asked of the app's own store only, so it keeps its final request across a
  // recording and replay facts never become the remembered target.
  const liveTarget = useCardTarget(dataStore, selection.selectedId);
  const liveCard = liveTarget !== null;
  const recordedTarget = useRecordedTarget(store, mode, selection.selectedId);
  // Settings opened on purpose takes the single sidebar. Otherwise needs-you takes it ahead of the
  // selected agent, and settings shows when neither applies. A request that arrives behind open
  // settings is still counted by the header.
  const cardOpen = mode === "history" ? (recordedTarget ?? null) !== null : liveCard;
  // Held here because the panel unmounts whenever the sidebar shows something else.
  const settingsOpen = useState(false);
  const sidebar = settingsOpen[0]
    ? SETTINGS_OVERLAY_ID
    : cardOpen
      ? ACTION_CARD_ID
      : selectedAgent
        ? AGENT_PANEL_ID
        : SETTINGS_OVERLAY_ID;
  useKeepToggleFocus(settingsOpen[0], sidebar);
  const storage = useMemo(localStorageOrNull, []);
  return (
    <div className={styles.layer} data-testid="overlay-root">
      <SettingsOpenContext.Provider value={settingsOpen}>
        <PresentedSidebar store={store} recordedTarget={recordedTarget} liveTarget={liveTarget}>
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
        {sidebar === SETTINGS_OVERLAY_ID ? null : <SettingsToggle />}
      </SettingsOpenContext.Provider>
      <p className={styles.badge}>
        {connection === "stale" ? "Taskville · stale" : "Taskville · paired"}
      </p>
    </div>
  );
}
