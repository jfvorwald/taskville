import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../../../src/data/domain.ts";
import { createDataStore } from "../../../src/data/store.ts";
import { createThemeController, type ThemeRoot } from "../../../src/themes/core/index.ts";
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
  });
});
