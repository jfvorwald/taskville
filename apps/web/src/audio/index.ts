import { useEffect } from "react";
import { dataStore } from "../data/store.ts";
import { themeController } from "../themes/core/index.ts";
import { createWebAudioBackend } from "./backend.ts";
import { connectSoundscape } from "./connect.ts";
import { loadAmbientLoop } from "./loops.ts";
import { getSoundSettingsStore } from "./settings.ts";
import { createSoundscape, type Soundscape } from "./soundscape.ts";

export type { AudioBackend, Cue } from "./backend.ts";
export { createWebAudioBackend } from "./backend.ts";
export { connectSoundscape } from "./connect.ts";
export {
  createSoundSettingsStore,
  DEFAULT_SOUND_SETTINGS,
  getSoundSettingsStore,
  type SoundSettings,
  type SoundSettingsStore,
} from "./settings.ts";
export { createSoundscape, type Soundscape } from "./soundscape.ts";

let appSoundscape: Soundscape | undefined;

/**
 * The app-wide soundscape, created on first use. Off until `enable()` is called from a click, and
 * it creates no AudioContext before that.
 */
export function getSoundscape(): Soundscape {
  appSoundscape ??= createSoundscape({
    backend: createWebAudioBackend(),
    settings: getSoundSettingsStore(),
    loadLoop: loadAmbientLoop,
    theme: themeController.store.getState().themeId,
  });
  return appSoundscape;
}

/** Feeds live attention, live events and the current theme to the soundscape while mounted. */
export function useSoundscape(): void {
  useEffect(
    () => connectSoundscape(getSoundscape(), { data: dataStore, theme: themeController.store }),
    [],
  );
}
