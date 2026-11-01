import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsStore, DEFAULT_SETTINGS } from "../../../src/overlays/settings/store.ts";
import { dispatchStorage, KEY, memoryStorage, stubWindow } from "./support.ts";

// Finding 1: the store follows changes other tabs make to the same storage.
// The fake window is a real EventTarget; the store must listen on `window` for "storage" events,
// re-read the changed key from its storage, validate it, update the snapshot and notify.

afterEach(() => vi.unstubAllGlobals());

describe("settings store, cross-tab", () => {
  it("picks up an external change to one of its keys: new snapshot, one notification", () => {
    const win = stubWindow();
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();

    storage.data.set(KEY("dayNight"), '"night"');
    dispatchStorage(win, { key: KEY("dayNight"), newValue: '"night"', storageArea: storage });

    expect(store.getSnapshot().dayNight).toBe("night");
    expect(store.getSnapshot()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);

    // Another origin key, or the same value again, is not a change.
    dispatchStorage(win, { key: "somebody.else", newValue: "1", storageArea: storage });
    dispatchStorage(win, { key: KEY("dayNight"), newValue: '"night"', storageArea: storage });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default when the external value is not valid", () => {
    const win = stubWindow();
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    store.set("dayNight", "night");
    const listener = vi.fn();
    store.subscribe(listener);

    storage.data.set(KEY("dayNight"), '"dusk"');
    dispatchStorage(win, { key: KEY("dayNight"), newValue: '"dusk"', storageArea: storage });

    expect(store.getSnapshot().dayNight).toBe(DEFAULT_SETTINGS.dayNight);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ends with storage and snapshot agreeing after the stale-tab sequence", () => {
    // Tab A and tab B share one storage. A stores night; B still shows auto; B picks Auto.
    const win = stubWindow();
    const storage = memoryStorage();
    const tabA = createSettingsStore(storage);
    const tabB = createSettingsStore(storage);

    tabA.set("dayNight", "night");
    dispatchStorage(win, { key: KEY("dayNight"), newValue: '"night"', storageArea: storage });
    tabB.set("dayNight", "auto");

    const stored = JSON.parse(storage.data.get(KEY("dayNight")) ?? "null");
    expect(tabB.getSnapshot().dayNight).toBe(stored);
  });

  it("writes a choice to storage even when its in-memory value is already equal", () => {
    // No event reaches this tab (it missed it): memory says auto, storage says night.
    stubWindow();
    const storage = memoryStorage();
    const tabB = createSettingsStore(storage);
    storage.data.set(KEY("dayNight"), '"night"');

    tabB.set("dayNight", "auto");

    expect(storage.data.get(KEY("dayNight"))).toBe('"auto"');
    expect(tabB.getSnapshot().dayNight).toBe("auto");
  });
});
