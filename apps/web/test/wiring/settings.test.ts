import { describe, expect, it } from "vitest";
import { cyberpunkTheme } from "../../src/themes/cyberpunk/index.ts";
import { connectSettings, lightingSettingFor, themeOptions } from "../../src/wiring/settings.ts";
import { rig, steampunkTheme, utc } from "./fixtures.ts";

describe("settings theme drives the theme controller", () => {
  it("applies the stored theme on connect and follows later changes", () => {
    const { settings, theme } = rig();
    settings.set("theme", "steampunk");
    const off = connectSettings({ settings, theme });
    expect(theme.store.getState().themeId).toBe("steampunk");

    settings.set("theme", "cyberpunk");
    expect(theme.store.getState().themeId).toBe("cyberpunk");
    off();
  });

  it("falls back to cyberpunk for an id that is not registered", () => {
    const { settings, theme } = rig();
    const off = connectSettings({ settings, theme });
    settings.set("theme", "steampunk");
    expect(theme.store.getState().themeId).toBe("steampunk");

    settings.set("theme", "removed-theme");
    expect(theme.store.getState().themeId).toBe("cyberpunk");
    off();
  });

  it("falls back on connect when the stored id is unknown", () => {
    const { settings, theme } = rig();
    theme.setTheme("steampunk");
    settings.set("theme", "gone");
    const off = connectSettings({ settings, theme });
    expect(theme.store.getState().themeId).toBe("cyberpunk");
    off();
  });

  it("stops following settings after the disposer runs", () => {
    const { settings, theme } = rig();
    const off = connectSettings({ settings, theme });
    off();
    settings.set("theme", "steampunk");
    expect(theme.store.getState().themeId).toBe("cyberpunk");
  });
});

describe("the real theme list feeds the settings panel", () => {
  it("maps registered themes to the panel's { id, label } options in order", () => {
    expect(themeOptions([cyberpunkTheme, steampunkTheme])).toEqual([
      { id: "cyberpunk", label: "Cyberpunk" },
      { id: "steampunk", label: "Steampunk" },
    ]);
  });
});

describe("dayNight drives lighting", () => {
  it("maps auto, day and night to cycle, always-day and always-night", () => {
    expect(lightingSettingFor("auto")).toBe("cycle");
    expect(lightingSettingFor("day")).toBe("always-day");
    expect(lightingSettingFor("night")).toBe("always-night");
  });

  it("pins the city to night and day, then releases it back to the clock", () => {
    // Noon UTC: the cycle is in day.
    const { settings, theme, lighting, clock } = rig({ now: utc("2026-10-31T12:00:00") });
    const off = connectSettings({ settings, theme, lighting });
    expect(lighting.getSetting()).toBe("cycle");
    expect(theme.store.getState().mode).toBe("day");

    settings.set("dayNight", "night");
    expect(lighting.getSetting()).toBe("always-night");
    expect(lighting.state().mode).toBe("night");
    expect(theme.store.getState().mode).toBe("night");

    settings.set("dayNight", "day");
    expect(lighting.getSetting()).toBe("always-day");
    expect(theme.store.getState().mode).toBe("day");

    // Release at midnight: auto follows the clock again, so the pin is gone.
    clock.now = utc("2026-10-31T00:30:00");
    settings.set("dayNight", "auto");
    expect(lighting.getSetting()).toBe("cycle");
    expect(lighting.state().mode).toBe("night");
    expect(theme.store.getState().mode).toBe("night");
    off();
  });

  it("applies a stored dayNight choice on connect", () => {
    const { settings, theme, lighting } = rig({ now: utc("2026-10-31T12:00:00") });
    settings.set("dayNight", "night");
    const off = connectSettings({ settings, theme, lighting });
    expect(lighting.getSetting()).toBe("always-night");
    expect(theme.store.getState().mode).toBe("night");
    off();
  });

  it("changes in one setting leave the other system alone", () => {
    const { settings, theme, lighting } = rig();
    const off = connectSettings({ settings, theme, lighting });
    settings.set("dayNight", "night");
    settings.set("theme", "steampunk");
    expect(lighting.getSetting()).toBe("always-night");
    expect(theme.store.getState().mode).toBe("night");
    expect(theme.store.getState().themeId).toBe("steampunk");
    off();
  });
});
