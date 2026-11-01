import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { areaSelectionId } from "../../src/city/interaction/selection.ts";

// The app registers only one theme today; a second one makes ?theme= observable. Hoisted, and
// re-run for every fresh module graph, so each boot gets its own controller.
vi.mock("../../src/themes/core/themes.ts", async () => {
  const { createThemeController } = await import("../../src/themes/core/controller.ts");
  const { cyberpunkTheme } = await import("../../src/themes/cyberpunk/index.ts");
  const steampunkTheme = { ...cyberpunkTheme, id: "steampunk" as const, name: "Steampunk" };
  const THEMES = [cyberpunkTheme, steampunkTheme];
  return { THEMES, themeController: createThemeController({ themes: THEMES }) };
});

// startWiring is the only thing that makes ?theme=, the day and night setting and the selected
// agent true in the running app, so it is tested through the real app-wide singletons. Each
// test gets fresh singletons (resetModules) and a fake window with in-memory storage.

function memoryLocalStorage() {
  const data = new Map<string, string>();
  const writes: string[] = [];
  return {
    data,
    writes,
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) {
      writes.push(key);
      data.set(key, value);
    },
  };
}

async function boot(search: string) {
  vi.resetModules();
  const [wiring, theme, lighting, settings, selection, data] = await Promise.all([
    import("../../src/wiring/index.ts"),
    import("../../src/themes/core/index.ts"),
    import("../../src/city/lighting/index.ts"),
    import("../../src/overlays/settings/index.ts"),
    import("../../src/city/interaction/selection.ts"),
    import("../../src/data/store.ts"),
  ]);
  // After the imports: react-aria inspects `window` while it loads. The wiring reads it later.
  const localStorage = memoryLocalStorage();
  vi.stubGlobal("window", { location: { search }, localStorage });
  return {
    localStorage,
    startWiring: wiring.startWiring,
    themeController: theme.themeController,
    lightingController: lighting.lightingController,
    settingsStore: settings.getSettingsStore(),
    selectionStore: selection.selectionStore,
    dataStore: data.dataStore,
  };
}

let dispose: (() => void) | undefined;

beforeEach(() => {
  dispose = undefined;
});

afterEach(() => {
  dispose?.();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("startWiring: ?theme= in the address", () => {
  it("selects the named theme and leaves the stored theme setting alone", async () => {
    const app = await boot("?theme=steampunk");
    dispose = app.startWiring();

    expect(app.themeController.store.getState().themeId).toBe("steampunk");
    expect(app.settingsStore.getSnapshot().theme).toBe("cyberpunk");
    expect(app.localStorage.writes).toEqual([]);
  });

  it("falls back to the default theme for an id that is not registered", async () => {
    const app = await boot("?theme=nope");
    dispose = app.startWiring();

    expect(app.themeController.store.getState().themeId).toBe("cyberpunk");
    expect(app.settingsStore.getSnapshot().theme).toBe("cyberpunk");
  });

  it("follows the stored theme setting when the address names none", async () => {
    const app = await boot("");
    dispose = app.startWiring();
    expect(app.themeController.store.getState().themeId).toBe("cyberpunk");

    app.settingsStore.set("theme", "steampunk");
    expect(app.themeController.store.getState().themeId).toBe("steampunk");
  });
});

describe("startWiring: the day and night setting reaches lighting", () => {
  it("pins lighting for night and day and returns to the cycle for auto", async () => {
    const app = await boot("");
    dispose = app.startWiring();
    expect(app.lightingController.getSetting()).toBe("cycle");

    app.settingsStore.set("dayNight", "night");
    expect(app.lightingController.getSetting()).toBe("always-night");
    app.settingsStore.set("dayNight", "day");
    expect(app.lightingController.getSetting()).toBe("always-day");
    app.settingsStore.set("dayNight", "auto");
    expect(app.lightingController.getSetting()).toBe("cycle");
  });

  it("stops following once the disposer has run", async () => {
    const app = await boot("");
    const off = app.startWiring();
    off();

    app.settingsStore.set("dayNight", "night");
    expect(app.lightingController.getSetting()).toBe("cycle");
  });
});

describe("startWiring: agent selection reaches the data store", () => {
  it("sets selectedAgentId for an agent selection and clears it for none", async () => {
    const app = await boot("");
    dispose = app.startWiring();

    app.selectionStore.select("a1");
    expect(app.dataStore.getState().selectedAgentId).toBe("a1");
    app.selectionStore.select(null);
    expect(app.dataStore.getState().selectedAgentId).toBeNull();
  });

  it("ignores an area: selection", async () => {
    const app = await boot("");
    dispose = app.startWiring();

    app.selectionStore.select("a1");
    app.selectionStore.select(areaSelectionId("archives"));
    expect(app.dataStore.getState().selectedAgentId).toBe("a1");
  });

  it("stops following once the disposer has run", async () => {
    const app = await boot("");
    const off = app.startWiring();
    off();

    app.selectionStore.select("a1");
    expect(app.dataStore.getState().selectedAgentId).toBeNull();
  });
});
