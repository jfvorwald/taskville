import { useSyncExternalStore } from "react";
import { selectionStore } from "../city/interaction/selection.ts";
import { lightingController } from "../city/lighting/index.ts";
import { dataStore } from "../data/store.ts";
import { getSettingsStore } from "../overlays/settings/index.ts";
import { themeController } from "../themes/core/index.ts";
import { reducedMotionSelector, systemReducedMotion } from "./motion.ts";
import { connectSelectedAgent } from "./selection.ts";
import { connectSettings } from "./settings.ts";
import { applyThemeQuery } from "./themeQuery.ts";

export { themedSettingsOverlay } from "./themedSettingsOverlay.tsx";

/**
 * Connects the viewer's settings to the systems they drive and the selection to the data store.
 * Call once when the app starts; the returned function undoes it. A `?theme=` in the address
 * wins over the stored theme for this page load and is never saved.
 */
export function startWiring(): () => void {
  const offSettings = connectSettings({
    settings: getSettingsStore(),
    theme: themeController,
    lighting: lightingController,
  });
  applyThemeQuery(window.location.search, themeController);
  const offSelection = connectSelectedAgent({ selection: selectionStore, data: dataStore });
  return () => {
    offSettings();
    offSelection();
  };
}

let reducedMotion: ReturnType<typeof reducedMotionSelector> | undefined;

/** Whether motion is reduced: the viewer's setting resolved against the OS preference. */
export function useReducedMotion(): boolean {
  reducedMotion ??= reducedMotionSelector(
    getSettingsStore(),
    systemReducedMotion(typeof matchMedia === "function" ? (q) => matchMedia(q) : undefined),
  );
  return useSyncExternalStore(
    reducedMotion.subscribe,
    reducedMotion.getSnapshot,
    reducedMotion.getSnapshot,
  );
}
