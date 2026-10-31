import type { StorageLike } from "../host/props.ts";
import type { Selector } from "../host/types.ts";

/** The overlay id the panel registers under; it also namespaces the stored keys. */
export const SETTINGS_OVERLAY_ID = "settings-panel";

export const DAY_NIGHT_CHOICES = ["auto", "day", "night"] as const;
export type DayNight = (typeof DAY_NIGHT_CHOICES)[number];

export const REDUCED_MOTION_CHOICES = ["system", "on", "off"] as const;
export type ReducedMotionSetting = (typeof REDUCED_MOTION_CHOICES)[number];

/**
 * What the viewer chose. This is the interface the theme system (M3.07) and lighting (M3.12)
 * read: `Selector<SettingsValues>`, a stable snapshot that changes only when a value does.
 */
export interface SettingsValues {
  /** A theme id. The store does not know which themes exist; the theme system falls back. */
  theme: string;
  /** `auto` follows the city clock, `day` and `night` pin the lighting. */
  dayNight: DayNight;
  /** `system` follows `prefers-reduced-motion`; resolve with `resolveReducedMotion`. */
  reducedMotion: ReducedMotionSetting;
}

export const DEFAULT_SETTINGS: SettingsValues = {
  theme: "cyberpunk",
  dayNight: "auto",
  reducedMotion: "system",
};

export interface SettingsStore extends Selector<SettingsValues> {
  set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]): void;
}

type Validators = { [K in keyof SettingsValues]: (value: unknown) => value is SettingsValues[K] };

const oneOf =
  <T extends string>(choices: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === "string" && (choices as readonly string[]).includes(value);

const VALID: Validators = {
  theme: (value): value is string => typeof value === "string" && value.length > 0,
  dayNight: oneOf(DAY_NIGHT_CHOICES),
  reducedMotion: oneOf(REDUCED_MOTION_CHOICES),
};

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof SettingsValues)[];

/** Same key shape as the overlay host's `settings` API, so both read and write the same values. */
const storageKey = (key: string) => `taskville.overlay.${SETTINGS_OVERLAY_ID}.${key}`;

function read<K extends keyof SettingsValues>(
  storage: StorageLike | null,
  key: K,
): SettingsValues[K] {
  try {
    const raw = storage?.getItem(storageKey(key));
    if (raw === null || raw === undefined) return DEFAULT_SETTINGS[key];
    const value: unknown = JSON.parse(raw);
    return VALID[key](value) ? value : DEFAULT_SETTINGS[key];
  } catch {
    return DEFAULT_SETTINGS[key];
  }
}

/**
 * The viewer's settings, kept in local storage and never sent to the engine. With no storage, or
 * storage that throws (private mode, full), the values still work for the life of the page.
 */
export function createSettingsStore(storage: StorageLike | null): SettingsStore {
  let snapshot = { ...DEFAULT_SETTINGS };
  for (const key of KEYS) (snapshot as Record<string, unknown>)[key] = read(storage, key);
  const listeners = new Set<() => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    set(key, value) {
      if (!VALID[key](value) || snapshot[key] === value) return;
      snapshot = { ...snapshot, [key]: value };
      try {
        storage?.setItem(storageKey(key), JSON.stringify(value));
      } catch {
        // A setting that does not stick across reloads is not worth a crash.
      }
      for (const listener of listeners) listener();
    },
  };
}

/** Whether animation should be reduced, given the setting and the OS `prefers-reduced-motion`. */
export function resolveReducedMotion(setting: ReducedMotionSetting, systemPrefers: boolean) {
  return setting === "system" ? systemPrefers : setting === "on";
}

let appStore: SettingsStore | undefined;

/** The app-wide store over `localStorage`, created on first use. */
export function getSettingsStore(): SettingsStore {
  if (!appStore) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // Blocked storage: in-memory only.
    }
    appStore = createSettingsStore(storage);
  }
  return appStore;
}
