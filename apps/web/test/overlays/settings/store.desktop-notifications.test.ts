import { describe, expect, it } from "vitest";
import { createSettingsStore, DEFAULT_SETTINGS } from "../../../src/overlays/settings/store.ts";
import { KEY, memoryStorage } from "./support.ts";

// M4.01: `desktopNotifications` is a viewer setting like the others: off by default, kept in
// local storage under the settings panel's namespace, and only an explicit boolean is accepted.

describe("desktopNotifications setting", () => {
  it("is off by default", () => {
    expect(DEFAULT_SETTINGS.desktopNotifications).toBe(false);
    expect(createSettingsStore(memoryStorage()).getSnapshot().desktopNotifications).toBe(false);
  });

  it("persists across a reload under the settings panel's key", () => {
    const storage = memoryStorage();
    createSettingsStore(storage).set("desktopNotifications", true);
    expect(storage.data.get(KEY("desktopNotifications"))).toBe("true");
    expect(createSettingsStore(storage).getSnapshot().desktopNotifications).toBe(true);
  });

  it("falls back to off when the stored value is not a boolean", () => {
    for (const raw of ['"yes"', "1", "null", "not json"]) {
      const storage = memoryStorage({ [KEY("desktopNotifications")]: raw });
      expect(createSettingsStore(storage).getSnapshot().desktopNotifications).toBe(false);
    }
  });

  it("notifies subscribers when it changes", () => {
    const store = createSettingsStore(memoryStorage());
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.set("desktopNotifications", true);
    expect(calls).toBe(1);
    expect(store.getSnapshot().desktopNotifications).toBe(true);
  });
});
