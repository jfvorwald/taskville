import { describe, expect, it } from "vitest";
import { createSoundSettingsStore, DEFAULT_SOUND_SETTINGS } from "../../src/audio/settings.ts";

// The sound preferences live in the audio module (Owns: apps/web/src/audio/**), persisted like the
// other viewer settings: local storage, never sent to the engine. "Enabled" is not a stored
// preference: browsers need a click on every page load, so it is runtime state on the soundscape.
// Storage keys are `taskville.audio.<key>`.

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("sound settings store", () => {
  it("defaults to a quiet, unmuted, full-soundscape setup", () => {
    expect(DEFAULT_SOUND_SETTINGS).toEqual({ volume: 0.5, muted: false, chimeOnly: false });
    expect(createSoundSettingsStore(null).getSnapshot()).toEqual(DEFAULT_SOUND_SETTINGS);
  });

  it("persists changes and reads them back in a new store", () => {
    const storage = memoryStorage();
    const first = createSoundSettingsStore(storage);
    first.set("volume", 0.8);
    first.set("muted", true);
    first.set("chimeOnly", true);
    expect(storage.data.get("taskville.audio.volume")).toBe("0.8");

    const second = createSoundSettingsStore(storage);
    expect(second.getSnapshot()).toEqual({ volume: 0.8, muted: true, chimeOnly: true });
  });

  it("keeps the same snapshot reference until a value changes, and notifies subscribers", () => {
    const store = createSoundSettingsStore(null);
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    const before = store.getSnapshot();
    store.set("volume", 0.5); // unchanged
    expect(store.getSnapshot()).toBe(before);
    expect(calls).toBe(0);

    store.set("volume", 0.7);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot().volume).toBe(0.7);
    expect(calls).toBe(1);
    off();
    store.set("volume", 0.9);
    expect(calls).toBe(1);
  });

  it("rejects invalid values and falls back from corrupt storage", () => {
    const store = createSoundSettingsStore(null);
    store.set("volume", 2);
    store.set("volume", Number.NaN);
    store.set("muted", "yes" as unknown as boolean);
    expect(store.getSnapshot()).toEqual(DEFAULT_SOUND_SETTINGS);

    const corrupt = memoryStorage();
    for (const key of ["volume", "muted", "chimeOnly"]) {
      corrupt.data.set(`taskville.audio.${key}`, "{not json");
    }
    expect(createSoundSettingsStore(corrupt).getSnapshot()).toEqual(DEFAULT_SOUND_SETTINGS);
  });

  it("keeps working when storage throws", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: (): void => {
        throw new Error("full");
      },
    };
    const store = createSoundSettingsStore(broken);
    store.set("muted", true);
    expect(store.getSnapshot().muted).toBe(true);
  });
});
