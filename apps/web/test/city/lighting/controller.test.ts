import { describe, expect, it } from "vitest";
import {
  createLightingController,
  type LightingSetting,
} from "../../../src/city/lighting/controller.ts";
import { createThemeController } from "../../../src/themes/core/index.ts";
import { cyberpunkTheme } from "../../../src/themes/cyberpunk/index.ts";

const utc = (iso: string) => Date.parse(`${iso}Z`);

function setup(opts: { now: number; timeZone?: string }) {
  const clock = { now: opts.now };
  const theme = createThemeController({ themes: [cyberpunkTheme] });
  const lighting = createLightingController({
    theme,
    now: () => clock.now,
    timeZone: opts.timeZone ?? "UTC",
  });
  return { clock, theme, lighting };
}

describe("lighting controller", () => {
  it("defaults to cycle and reads the clock in the given time zone", () => {
    const { lighting } = setup({ now: utc("2026-10-31T12:00:00"), timeZone: "Asia/Tokyo" });
    expect(lighting.getSetting()).toBe("cycle");
    // 12:00 UTC is 21:00 in Tokyo: night.
    expect(lighting.state().phase).toBe("night");
  });

  it("drives the theme mode from the phase", () => {
    const { lighting, theme, clock } = setup({ now: utc("2026-10-31T12:00:00") });
    expect(theme.store.getState().mode).toBe("day");
    clock.now = utc("2026-10-31T23:00:00");
    lighting.tick();
    expect(theme.store.getState().mode).toBe("night");
    clock.now = utc("2026-11-01T09:00:00");
    lighting.tick();
    expect(theme.store.getState().mode).toBe("day");
  });

  it("an injected time overrides the clock and clearing it returns to the clock", () => {
    const { lighting, theme } = setup({ now: utc("2026-10-31T12:00:00") });
    lighting.setTime(utc("2026-10-31T02:00:00"));
    expect(lighting.state().phase).toBe("night");
    expect(theme.store.getState().mode).toBe("night");
    expect(lighting.getTime()).toBe(utc("2026-10-31T02:00:00"));
    lighting.setTime(null);
    expect(lighting.state().phase).toBe("day");
    expect(theme.store.getState().mode).toBe("day");
  });

  it("an injected time is read in the controller's zone", () => {
    const { lighting } = setup({ now: 0, timeZone: "America/Los_Angeles" });
    lighting.setTime(utc("2026-10-31T19:00:00")); // 12:00 in Los Angeles (PDT)
    expect(lighting.state().phase).toBe("day");
  });

  it("always-day and always-night ignore the time", () => {
    const { lighting, theme } = setup({ now: utc("2026-10-31T12:00:00") });
    lighting.setSetting("always-night" satisfies LightingSetting);
    expect(lighting.state().nightness).toBe(1);
    expect(theme.store.getState().mode).toBe("night");
    lighting.setSetting("always-day");
    expect(lighting.state().nightness).toBe(0);
    expect(theme.store.getState().mode).toBe("day");
    lighting.setTime(utc("2026-10-31T02:00:00"));
    expect(lighting.state().nightness).toBe(0);
    lighting.setSetting("cycle");
    expect(lighting.state().phase).toBe("night");
  });

  it("notifies subscribers only when the state changes", () => {
    const { lighting, clock } = setup({ now: utc("2026-10-31T12:00:00") });
    let calls = 0;
    const off = lighting.subscribe(() => {
      calls += 1;
    });
    lighting.tick();
    expect(calls).toBe(0);
    clock.now = utc("2026-10-31T12:10:00");
    lighting.tick();
    expect(calls).toBeGreaterThan(0);
    off();
  });

  it("start() ticks on an interval and the stop function ends it", () => {
    const { lighting, clock, theme } = setup({ now: utc("2026-10-31T12:00:00") });
    let fire: (() => void) | undefined;
    let cleared = false;
    const stop = lighting.start({
      intervalMs: 1000,
      setInterval: (fn) => {
        fire = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        cleared = true;
      },
    });
    clock.now = utc("2026-10-31T23:00:00");
    fire?.();
    expect(theme.store.getState().mode).toBe("night");
    stop();
    expect(cleared).toBe(true);
  });
});
