import type { OverlayDefinition, OverlayProps } from "../overlays/host/index.ts";
import { SettingsPanel, settingsOverlay } from "../overlays/settings/index.ts";
import { THEMES } from "../themes/core/index.ts";
import { themeOptions } from "./settings.ts";

const THEME_OPTIONS = themeOptions(THEMES);

function ThemedSettingsPanel(props: OverlayProps) {
  return <SettingsPanel {...props} themes={THEME_OPTIONS} />;
}

/** The settings overlay listing the registered themes instead of the panel's placeholder list. */
export const themedSettingsOverlay: OverlayDefinition = {
  ...settingsOverlay,
  Component: ThemedSettingsPanel,
};
