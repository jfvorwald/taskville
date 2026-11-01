import type { LightingController, LightingSetting } from "../city/lighting/index.ts";
import {
  type DayNight,
  DEFAULT_SETTINGS,
  type SettingsStore,
  type SettingsValues,
} from "../overlays/settings/store.ts";
import type { ThemeController, ThemeDefinition } from "../themes/core/index.ts";

const LIGHTING_FOR: Record<DayNight, LightingSetting> = {
  auto: "cycle",
  day: "always-day",
  night: "always-night",
};

/** The lighting setting for the viewer's day and night choice. */
export function lightingSettingFor(dayNight: DayNight): LightingSetting {
  return LIGHTING_FOR[dayNight];
}

/** The settings panel's `{ id, label }` options for the registered themes, in order. */
export function themeOptions(
  themes: readonly Pick<ThemeDefinition, "id" | "name">[],
): { id: string; label: string }[] {
  return themes.map((t) => ({ id: t.id, label: t.name }));
}

export interface ConnectSettingsOptions {
  settings: Pick<SettingsStore, "getSnapshot" | "subscribe">;
  theme: Pick<ThemeController, "setTheme">;
  /** Left alone when absent. */
  lighting?: Pick<LightingController, "setSetting">;
}

/**
 * Applies the viewer's settings to the theme and lighting systems now and on every change, each
 * one only when its own value changed. An id the theme system does not know falls back to the
 * default theme. Returns the disposer.
 */
export function connectSettings({ settings, theme, lighting }: ConnectSettingsOptions) {
  const apply = (next: SettingsValues, prev: SettingsValues | null) => {
    if (prev === null || next.theme !== prev.theme) {
      if (!theme.setTheme(next.theme)) theme.setTheme(DEFAULT_SETTINGS.theme);
    }
    if (prev === null || next.dayNight !== prev.dayNight) {
      lighting?.setSetting(lightingSettingFor(next.dayNight));
    }
  };
  let last = settings.getSnapshot();
  apply(last, null);
  return settings.subscribe(() => {
    const next = settings.getSnapshot();
    const prev = last;
    last = next;
    apply(next, prev);
  });
}
