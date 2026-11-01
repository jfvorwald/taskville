import { useSyncExternalStore } from "react";
import type { OverlayDefinition, OverlayProps } from "../overlays/host/index.ts";
import { getSettingsStore, SettingsPanel, settingsOverlay } from "../overlays/settings/index.ts";
import { THEMES, themeController } from "../themes/core/index.ts";
import { themeOptions } from "./settings.ts";

const THEME_OPTIONS = themeOptions(THEMES);

const themeInUse = () => themeController.store.getState().themeId;

function ThemedSettingsPanel(props: OverlayProps) {
  // The theme in use can differ from the stored setting (?theme=...), so the panel shows the
  // controller's. Choosing applies it directly: the store does not notify when the stored value
  // is unchanged, which would leave the city on the other theme.
  const themeId = useSyncExternalStore(themeController.store.subscribe, themeInUse, themeInUse);
  return (
    <SettingsPanel
      {...props}
      themes={THEME_OPTIONS}
      themeId={themeId}
      onThemeChange={(id) => {
        themeController.setTheme(id);
        getSettingsStore().set("theme", id);
      }}
    />
  );
}

/** The settings overlay listing the registered themes instead of the panel's placeholder list. */
export const themedSettingsOverlay: OverlayDefinition = {
  ...settingsOverlay,
  Component: ThemedSettingsPanel,
};
