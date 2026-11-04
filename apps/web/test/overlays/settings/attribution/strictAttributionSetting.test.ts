import { describe, expect, it } from "vitest";
import { createSettingsStore, DEFAULT_SETTINGS } from "../../../../src/overlays/settings/store.ts";

// M5.13: the setting is the boolean `strictAttribution` in the settings store (store.ts), stored
// like privacyMode under `taskville.overlay.settings-panel.strictAttribution`, off by default.
//   pnpm --filter @taskville/web exec vitest run --root ../.. --project @taskville/web \
//     test/overlays/settings/attribution

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const KEY = "taskville.overlay.settings-panel.strictAttribution";

describe("strictAttribution setting", () => {
  it("is off by default", () => {
    expect(DEFAULT_SETTINGS.strictAttribution).toBe(false);
    expect(createSettingsStore(memoryStorage()).getSnapshot().strictAttribution).toBe(false);
  });

  it("is stored under the host's namespaced key", () => {
    const storage = memoryStorage();
    createSettingsStore(storage).set("strictAttribution", true);
    expect(storage.data.get(KEY)).toBe("true");
  });

  it("persists across a reload (a new store over the same storage)", () => {
    const storage = memoryStorage();
    createSettingsStore(storage).set("strictAttribution", true);
    expect(createSettingsStore(storage).getSnapshot().strictAttribution).toBe(true);
    createSettingsStore(storage).set("strictAttribution", false);
    expect(createSettingsStore(storage).getSnapshot().strictAttribution).toBe(false);
  });

  it("notifies subscribers when it changes", () => {
    const store = createSettingsStore(memoryStorage());
    let calls = 0;
    store.subscribe(() => calls++);
    store.set("strictAttribution", true);
    expect(calls).toBe(1);
    expect(store.getSnapshot().strictAttribution).toBe(true);
  });

  it("falls back to off for a stored value that is not a boolean", () => {
    const store = createSettingsStore(memoryStorage({ [KEY]: '"yes"' }));
    expect(store.getSnapshot().strictAttribution).toBe(false);
  });
});
