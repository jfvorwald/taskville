import { describe, expect, it } from "vitest";
import { connectSettings } from "../../src/wiring/settings.ts";
import { applyThemeQuery, themeFromQuery } from "../../src/wiring/themeQuery.ts";
import { rig } from "./fixtures.ts";

describe("?theme= selects the theme at load", () => {
  it("reads the id from the query string, or null when absent or empty", () => {
    expect(themeFromQuery("?theme=steampunk")).toBe("steampunk");
    expect(themeFromQuery("?debug=movement&theme=aero")).toBe("aero");
    expect(themeFromQuery("")).toBeNull();
    expect(themeFromQuery("?theme=")).toBeNull();
    expect(themeFromQuery("?other=1")).toBeNull();
  });

  it("switches to a registered theme", () => {
    const { theme } = rig();
    expect(applyThemeQuery("?theme=steampunk", theme)).toBe(true);
    expect(theme.store.getState().themeId).toBe("steampunk");
  });

  it("falls back to cyberpunk for an unknown id", () => {
    const { theme } = rig();
    theme.setTheme("steampunk");
    applyThemeQuery("?theme=does-not-exist", theme);
    expect(theme.store.getState().themeId).toBe("cyberpunk");
  });

  it("changes nothing without a theme parameter", () => {
    const { theme } = rig();
    theme.setTheme("steampunk");
    expect(applyThemeQuery("?debug=movement", theme)).toBe(false);
    expect(theme.store.getState().themeId).toBe("steampunk");
  });

  it("does not persist: the settings store and its storage are untouched", () => {
    const { theme, settings, storage } = rig();
    const off = connectSettings({ settings, theme });
    applyThemeQuery("?theme=steampunk", theme);
    expect(theme.store.getState().themeId).toBe("steampunk");
    expect(settings.getSnapshot().theme).toBe("cyberpunk");
    expect(storage.writes).toEqual([]);
    off();
  });
});
