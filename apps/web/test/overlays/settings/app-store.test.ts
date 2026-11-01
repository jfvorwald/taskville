import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../src/overlays/settings/store.ts";
import { KEY, memoryStorage, stubWindow } from "./support.ts";

// Finding 3: getSettingsStore, the app-wide singleton over window.localStorage.
// It is cached in module state, so each test calls vi.resetModules() and re-imports the module
// with `await import(...)` to get a fresh singleton. Globals are restored in afterEach.
// NOTE: these characterize existing behavior, so they are expected to pass already.

const load = async () => (await import("../../../src/overlays/settings/store.ts")).getSettingsStore;

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("getSettingsStore", () => {
  it("returns the same store on every call within one module instance", async () => {
    stubWindow(memoryStorage());
    const getSettingsStore = await load();
    expect(getSettingsStore()).toBe(getSettingsStore());
  });

  it("yields the defaults and a working in-memory set when window.localStorage throws", async () => {
    stubWindow({
      get: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    const store = (await load())();
    expect(store.getSnapshot()).toEqual(DEFAULT_SETTINGS);
    store.set("dayNight", "night");
    expect(store.getSnapshot().dayNight).toBe("night");
  });

  it("persists through window.localStorage across a fresh module instance (reload)", async () => {
    const local = memoryStorage();
    stubWindow(local);
    (await load())().set("reducedMotion", "on");
    expect(local.data.get(KEY("reducedMotion"))).toBe('"on"');

    vi.resetModules();
    const reloaded = (await load())();
    expect(reloaded.getSnapshot().reducedMotion).toBe("on");
  });
});
