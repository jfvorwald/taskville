import { DEFAULT_SETTINGS } from "../overlays/settings/index.ts";
import type { ThemeController } from "../themes/core/index.ts";

/** The `theme` query parameter, or null when it is absent or empty. */
export function themeFromQuery(search: string): string | null {
  const id = new URLSearchParams(search).get("theme");
  return id === null || id === "" ? null : id;
}

/**
 * Selects the theme named by `?theme=<id>`, falling back to the default theme for an id that is
 * not registered. Touches the theme controller only: nothing is saved to the settings.
 * Returns whether the query named a theme.
 */
export function applyThemeQuery(search: string, theme: Pick<ThemeController, "setTheme">) {
  const id = themeFromQuery(search);
  if (id === null) return false;
  if (!theme.setTheme(id)) theme.setTheme(DEFAULT_SETTINGS.theme);
  return true;
}
