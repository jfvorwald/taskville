import { createLightingController } from "../../src/city/lighting/controller.ts";
import { createSettingsStore } from "../../src/overlays/settings/store.ts";
import { createThemeController, type ThemeDefinition } from "../../src/themes/core/index.ts";
import { cyberpunkTheme } from "../../src/themes/cyberpunk/index.ts";

export const utc = (iso: string) => Date.parse(`${iso}Z`);

/** A second registered theme, so switching and falling back are observable. */
export const steampunkTheme: ThemeDefinition = {
  ...cyberpunkTheme,
  id: "steampunk",
  name: "Steampunk",
  tokens: { ...cyberpunkTheme.tokens, "--tv-text": "#f1e2c4", "--tv-text-muted": "#b59f78" },
};

export function memoryStorage() {
  const data = new Map<string, string>();
  const writes: string[] = [];
  return {
    data,
    writes,
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) {
      writes.push(key);
      data.set(key, value);
    },
  };
}

/** Real settings store, theme controller (two themes) and lighting controller on a fixed clock. */
export function rig(opts: { now?: number } = {}) {
  const storage = memoryStorage();
  const settings = createSettingsStore(storage);
  const theme = createThemeController({ themes: [cyberpunkTheme, steampunkTheme] });
  const clock = { now: opts.now ?? utc("2026-10-31T12:00:00") };
  const lighting = createLightingController({ theme, now: () => clock.now, timeZone: "UTC" });
  return { storage, settings, theme, lighting, clock };
}
