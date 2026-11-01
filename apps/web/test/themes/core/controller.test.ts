import { describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../../src/data/domain.ts";
import { createDataStore } from "../../../src/data/store.ts";
import {
  CITY_PALETTE_KEYS,
  cityPaletteFromTokens,
  cityToken,
  createThemeController,
  resolveTokens,
  type ThemeController,
  type ThemeRoot,
} from "../../../src/themes/core/index.ts";
import { cyberpunkTheme } from "../../../src/themes/cyberpunk/index.ts";
import { eventBuilder, PROJECT, registered } from "../../data/fake-engine.ts";
import { otherTheme } from "./fixtures.ts";

function fakeRoot() {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root: ThemeRoot = {
    style: {
      setProperty: (k, v) => void props.set(k, v),
    },
    setAttribute: (k, v) => void attrs.set(k, v),
  };
  return { root, props, attrs };
}

/** Every published property is the resolved token for the active theme and mode. */
function expectPublished(c: ThemeController, props: Map<string, string>) {
  const { themeId, mode, tokens } = c.store.getState();
  const def = c.themes.find((t) => t.id === themeId);
  if (def === undefined) throw new Error(`no theme ${themeId}`);
  const resolved = resolveTokens(def, mode);
  expect(tokens).toEqual(resolved);
  for (const [name, value] of Object.entries(resolved)) expect(props.get(name), name).toBe(value);
  const palette = cityPaletteFromTokens(tokens);
  for (const key of CITY_PALETTE_KEYS) expect(palette[key], key).toBe(props.get(cityToken(key)));
}

describe("theme controller", () => {
  it("starts on the first theme in day mode and lists the themes", () => {
    const c = createThemeController({ themes: [cyberpunkTheme, otherTheme] });
    expect(c.store.getState()).toMatchObject({ themeId: "cyberpunk", mode: "day", history: false });
    expect(c.themes.map((t) => t.id)).toEqual(["cyberpunk", "steampunk"]);
  });

  it("publishes the active token set as CSS custom properties and data attributes", () => {
    const c = createThemeController({ themes: [cyberpunkTheme, otherTheme] });
    const { root, props, attrs } = fakeRoot();
    c.attach(root);
    expect(props.get("--tv-scene-bg")).toBe(cyberpunkTheme.tokens["--tv-scene-bg"]);
    expect(attrs.get("data-theme")).toBe("cyberpunk");
    c.setTheme("steampunk");
    expect(props.get("--tv-scene-bg")).toBe(otherTheme.tokens["--tv-scene-bg"]);
    expect(attrs.get("data-theme")).toBe("steampunk");
    c.setMode("night");
    expect(attrs.get("data-mode")).toBe("night");
    c.setHistory(true);
    expect(attrs.get("data-history")).toBe("true");
  });

  it("ignores an unknown theme id", () => {
    const c = createThemeController({ themes: [cyberpunkTheme] });
    expect(c.setTheme("nope")).toBe(false);
    expect(c.store.getState().themeId).toBe("cyberpunk");
  });

  it("stops publishing after detach", () => {
    const c = createThemeController({ themes: [cyberpunkTheme, otherTheme] });
    const { root, attrs } = fakeRoot();
    const detach = c.attach(root);
    detach();
    c.setTheme("steampunk");
    expect(attrs.get("data-theme")).toBe("cyberpunk");
  });

  it("switching theme preserves store state and selection", () => {
    const emit = eventBuilder();
    const data = createDataStore({ now: () => Date.parse("2026-10-30T10:30:00Z") });
    data.getState().reset(PROJECT);
    data
      .getState()
      .applySnapshotState(registered(emit, "a1", "a2").reduce(reduce, initialState(PROJECT)));
    data.getState().select("a2");
    const before = data.getState();
    const spy = vi.fn();
    data.subscribe(spy);

    const c = createThemeController({ themes: [cyberpunkTheme, otherTheme] });
    c.attach(fakeRoot().root);
    c.setTheme("steampunk");
    c.setMode("night");
    c.setTheme("cyberpunk");

    const after = data.getState();
    expect(after).toBe(before);
    expect(after.selectedAgentId).toBe("a2");
    expect(after.agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(after.cursor).toBe(before.cursor);
    expect(spy).not.toHaveBeenCalled();
  });

  it("publishes exactly resolveTokens(theme, mode) after attach, on mode and theme changes", () => {
    const c = createThemeController({ themes: [cyberpunkTheme, otherTheme] });
    const { root, props } = fakeRoot();
    c.attach(root);
    expectPublished(c, props);
    c.setMode("night");
    expectPublished(c, props);
    c.setTheme("steampunk");
    expectPublished(c, props);
    c.setMode("day");
    expectPublished(c, props);
    c.setTheme("cyberpunk");
    expectPublished(c, props);
  });

  it("keeps the same tokens object when a history toggle changes neither theme nor mode", () => {
    const c = createThemeController({ themes: [cyberpunkTheme, otherTheme] });
    c.setMode("night"); // night merges overrides into a fresh object, so a rebuild is visible
    const before = c.store.getState().tokens;
    c.setHistory(true);
    expect(c.store.getState().history).toBe(true);
    expect(c.store.getState().tokens).toBe(before);
    c.setHistory(false);
    expect(c.store.getState().tokens).toBe(before);
  });
});
