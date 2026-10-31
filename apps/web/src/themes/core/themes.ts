import { aeroTheme } from "../aero/index.ts";
import { cyberpunkTheme } from "../cyberpunk/index.ts";
import type { ThemeDefinition } from "./contract.ts";
import { createThemeController } from "./controller.ts";

/**
 * The registered themes and the app-wide controller. M3.08 to M3.10 each add one import and one
 * entry here (steampunk, solarpunk, aero). The first entry is the default theme.
 */
export const THEMES: readonly ThemeDefinition[] = [cyberpunkTheme, aeroTheme];

export const themeController = createThemeController({ themes: THEMES });
