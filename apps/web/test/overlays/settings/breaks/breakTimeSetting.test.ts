import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsStore, DEFAULT_SETTINGS } from "../../../../src/overlays/settings/store.ts";
import { dispatchStorage, KEY, memoryStorage, stubWindow } from "../support.ts";

// M9.04: the setting is the boolean `breakTime` in the settings store (store.ts), stored like the
// other settings under `taskville.overlay.settings-panel.breakTime`, ON by default (the owner asked
// for breaks), validated as a boolean, and followed across tabs.
//   pnpm --filter @taskville/web exec vitest run --root ../.. --project @taskville/web \
//     test/overlays/settings/breaks

afterEach(() => vi.unstubAllGlobals());

describe("breakTime setting", () => {
  it("is on by default", () => {
    expect(DEFAULT_SETTINGS.breakTime).toBe(true);
    expect(createSettingsStore(memoryStorage()).getSnapshot().breakTime).toBe(true);
  });

  it("is stored under the host's namespaced key", () => {
    const storage = memoryStorage();
    createSettingsStore(storage).set("breakTime", false);
    expect(storage.data.get(KEY("breakTime"))).toBe("false");
  });

  it("persists across a reload (a new store over the same storage)", () => {
    const storage = memoryStorage();
    createSettingsStore(storage).set("breakTime", false);
    expect(createSettingsStore(storage).getSnapshot().breakTime).toBe(false);
    createSettingsStore(storage).set("breakTime", true);
    expect(createSettingsStore(storage).getSnapshot().breakTime).toBe(true);
  });

  it("notifies subscribers once when it changes, not when it is set to the same value", () => {
    const store = createSettingsStore(memoryStorage());
    let calls = 0;
    store.subscribe(() => calls++);
    store.set("breakTime", true);
    expect(calls).toBe(0);
    store.set("breakTime", false);
    expect(calls).toBe(1);
    expect(store.getSnapshot().breakTime).toBe(false);
  });

  it("falls back to on for a stored value that is not a boolean", () => {
    for (const raw of ['"no"', "0", "null", "{}"]) {
      const store = createSettingsStore(memoryStorage({ [KEY("breakTime")]: raw }));
      expect(store.getSnapshot().breakTime).toBe(true);
    }
  });

  it("ignores a set with a value that is not a boolean", () => {
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    (store as { set: (k: string, v: unknown) => void }).set("breakTime", "off");
    expect(store.getSnapshot().breakTime).toBe(true);
    expect(storage.data.has(KEY("breakTime"))).toBe(false);
  });

  it("follows a change another tab makes, with one notification", () => {
    const win = stubWindow();
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);

    storage.data.set(KEY("breakTime"), "false");
    dispatchStorage(win, { key: KEY("breakTime"), newValue: "false", storageArea: storage });
    expect(store.getSnapshot().breakTime).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    storage.data.set(KEY("breakTime"), "true");
    dispatchStorage(win, { key: KEY("breakTime"), newValue: "true", storageArea: storage });
    expect(store.getSnapshot().breakTime).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("goes back to on when storage is cleared in another tab", () => {
    const win = stubWindow();
    const storage = memoryStorage({ [KEY("breakTime")]: "false" });
    const store = createSettingsStore(storage);
    expect(store.getSnapshot().breakTime).toBe(false);
    storage.data.clear();
    dispatchStorage(win, { key: null, newValue: null, storageArea: storage });
    expect(store.getSnapshot().breakTime).toBe(true);
  });
});
