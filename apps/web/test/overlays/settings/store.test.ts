import { describe, expect, it, vi } from "vitest";
import {
  createSettingsStore,
  DEFAULT_SETTINGS,
  resolveReducedMotion,
} from "../../../src/overlays/settings/store.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("settings store", () => {
  it("starts from the defaults when nothing is stored", () => {
    expect(createSettingsStore(memoryStorage()).getSnapshot()).toEqual(DEFAULT_SETTINGS);
  });

  it("stores each setting under the host's namespaced key", () => {
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    store.set("dayNight", "night");
    expect(storage.data.get("taskville.overlay.settings-panel.dayNight")).toBe('"night"');
  });

  it("restores stored values in a new store (reload)", () => {
    const storage = memoryStorage();
    const first = createSettingsStore(storage);
    first.set("theme", "cyberpunk");
    first.set("dayNight", "day");
    first.set("reducedMotion", "on");
    const second = createSettingsStore(storage);
    expect(second.getSnapshot()).toMatchObject({
      theme: "cyberpunk",
      dayNight: "day",
      reducedMotion: "on",
    });
  });

  it("falls back to the default for stored values that are not valid choices", () => {
    const storage = memoryStorage({
      "taskville.overlay.settings-panel.dayNight": '"dusk"',
      "taskville.overlay.settings-panel.reducedMotion": "not json",
      "taskville.overlay.settings-panel.theme": "42",
    });
    expect(createSettingsStore(storage).getSnapshot()).toEqual(DEFAULT_SETTINGS);
  });

  it("notifies subscribers on change only, and hands out a stable snapshot between changes", () => {
    const store = createSettingsStore(memoryStorage());
    const listener = vi.fn();
    const off = store.subscribe(listener);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.set("dayNight", "night");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    store.set("dayNight", "night");
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.set("dayNight", "day");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores a value that is not a valid choice", () => {
    const store = createSettingsStore(memoryStorage());
    store.set("dayNight", "dusk" as never);
    expect(store.getSnapshot().dayNight).toBe(DEFAULT_SETTINGS.dayNight);
  });

  it("keeps working in memory when storage is missing or throws", () => {
    const none = createSettingsStore(null);
    none.set("dayNight", "night");
    expect(none.getSnapshot().dayNight).toBe("night");
    const broken = createSettingsStore({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    });
    broken.set("reducedMotion", "off");
    expect(broken.getSnapshot().reducedMotion).toBe("off");
  });
});

describe("resolveReducedMotion", () => {
  it("follows the system when set to system, and overrides it otherwise", () => {
    expect(resolveReducedMotion("system", true)).toBe(true);
    expect(resolveReducedMotion("system", false)).toBe(false);
    expect(resolveReducedMotion("on", false)).toBe(true);
    expect(resolveReducedMotion("off", true)).toBe(false);
  });
});
