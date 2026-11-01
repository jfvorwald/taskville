/** The slice of `Storage` the sound settings use. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A read-only view of some state, shaped for `useSyncExternalStore`. */
export interface Readable<T> {
  subscribe(listener: () => void): () => void;
  /** Returns the same reference until the value changes. */
  getSnapshot(): T;
}

/**
 * What the viewer chose for sound. "Enabled" is deliberately not here: browsers need a click on
 * every page load, so it is runtime state on the soundscape.
 */
export interface SoundSettings {
  /** Master volume, 0 to 1. */
  volume: number;
  muted: boolean;
  /** Chimes only: no ambient loop, no completion ticks, no handoff pops. */
  chimeOnly: boolean;
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  volume: 0.5,
  muted: false,
  chimeOnly: false,
};

export interface SoundSettingsStore extends Readable<SoundSettings> {
  set<K extends keyof SoundSettings>(key: K, value: SoundSettings[K]): void;
}

type Validators = { [K in keyof SoundSettings]: (value: unknown) => value is SoundSettings[K] };

const VALID: Validators = {
  volume: (value): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
  muted: (value): value is boolean => typeof value === "boolean",
  chimeOnly: (value): value is boolean => typeof value === "boolean",
};

const KEYS = Object.keys(DEFAULT_SOUND_SETTINGS) as (keyof SoundSettings)[];

const storageKey = (key: string) => `taskville.audio.${key}`;

function read<K extends keyof SoundSettings>(
  storage: StorageLike | null,
  key: K,
): SoundSettings[K] {
  try {
    const raw = storage?.getItem(storageKey(key));
    if (raw === null || raw === undefined) return DEFAULT_SOUND_SETTINGS[key];
    const value: unknown = JSON.parse(raw);
    return VALID[key](value) ? value : DEFAULT_SOUND_SETTINGS[key];
  } catch {
    return DEFAULT_SOUND_SETTINGS[key];
  }
}

/**
 * The viewer's sound settings, kept in local storage and never sent to the engine. With no
 * storage, or storage that throws, the values still work for the life of the page.
 */
export function createSoundSettingsStore(storage: StorageLike | null): SoundSettingsStore {
  let snapshot = { ...DEFAULT_SOUND_SETTINGS };
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
      if (!VALID[key](value)) return;
      try {
        storage?.setItem(storageKey(key), JSON.stringify(value));
      } catch {
        // A setting that does not stick across reloads is not worth a crash.
      }
      if (snapshot[key] === value) return;
      snapshot = { ...snapshot, [key]: value };
      for (const listener of [...listeners]) listener();
    },
  };
}

let appStore: SoundSettingsStore | undefined;

/** The app-wide store over `localStorage`, created on first use. */
export function getSoundSettingsStore(): SoundSettingsStore {
  if (!appStore) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // Blocked storage: in-memory only.
    }
    appStore = createSoundSettingsStore(storage);
  }
  return appStore;
}
