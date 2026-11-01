import { Canvas } from "@react-three/fiber";
import type { Color, DirectionalLight, HemisphereLight, Scene } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  resolveTokens,
  THEMES,
  type ThemeDefinition,
  themeController,
} from "../../themes/core/index.ts";
import { cyberpunkTheme } from "../../themes/cyberpunk/index.ts";
import { createLightingController } from "./controller.ts";
import { DayNightLighting } from "./DayNightLighting.tsx";
import { DAY_AMBIENT, DAY_SUN, NIGHT_AMBIENT, NIGHT_SUN } from "./phase.ts";

const NOON = Date.parse("2026-10-31T12:00:00Z");
const MIDNIGHT = Date.parse("2026-10-31T00:00:00Z");

// A second theme with a night sky and a day sky that differ from cyberpunk's. Only cyberpunk is
// registered today (M3.08 to M3.10 add the rest), so this is added to the registry for the test.
const ALT_ID = "alt-test" as ThemeDefinition["id"];
const altTheme: ThemeDefinition = {
  ...cyberpunkTheme,
  id: ALT_ID,
  name: "Alt",
  tokens: { ...cyberpunkTheme.tokens, "--tv-scene-bg": "#a0c8ff" },
  night: { ...cyberpunkTheme.night, "--tv-scene-bg": "#2a0a3a" },
};

const registry = THEMES as ThemeDefinition[];
const originalThemeId = themeController.store.getState().themeId;

afterEach(() => {
  const at = registry.indexOf(altTheme);
  if (at >= 0) registry.splice(at, 1);
  themeController.setTheme(originalThemeId);
  themeController.setMode("day");
});

function lightingAt(instant: number) {
  return createLightingController({ theme: themeController, now: () => instant, timeZone: "UTC" });
}

async function mount(controller = lightingAt(NOON)) {
  let scene: Scene | undefined;
  await render(
    <div style={{ width: 200, height: 150 }}>
      <Canvas
        onCreated={(state) => {
          scene = state.scene;
        }}
      >
        <DayNightLighting controller={controller} start={false} />
      </Canvas>
    </div>,
  );
  await vi.waitFor(() => expect(scene).toBeDefined());
  const find = <T,>(name: string) => {
    const found = scene?.getObjectByName(name);
    expect(found, `light ${name}`).toBeDefined();
    return found as unknown as T;
  };
  return {
    controller,
    scene: scene as Scene,
    hemisphere: () => find<HemisphereLight>("lighting-hemisphere"),
    sun: () => find<DirectionalLight>("lighting-sun"),
  };
}

const hex = (c: unknown) => `#${(c as Color).getHexString()}`;

describe("DayNightLighting", () => {
  it("draws a hemisphere light and a sun with the day intensities at noon", async () => {
    const view = await mount(lightingAt(NOON));
    await vi.waitFor(() => {
      expect(view.hemisphere().intensity).toBeCloseTo(DAY_AMBIENT, 3);
      expect(view.sun().intensity).toBeCloseTo(DAY_SUN, 3);
    });
    expect(view.hemisphere().type).toBe("HemisphereLight");
    expect(view.sun().type).toBe("DirectionalLight");
  });

  it("uses the night intensities at night, and follows the controller from day to night", async () => {
    const view = await mount(lightingAt(NOON));
    await vi.waitFor(() => expect(view.sun().intensity).toBeCloseTo(DAY_SUN, 3));
    view.controller.setTime(MIDNIGHT);
    await vi.waitFor(() => {
      expect(view.hemisphere().intensity).toBeCloseTo(NIGHT_AMBIENT, 3);
      expect(view.sun().intensity).toBeCloseTo(NIGHT_SUN, 3);
    });
  });

  it("sets the scene background to the theme's sky for the lighting", async () => {
    const view = await mount(lightingAt(NOON));
    const day = resolveTokens(cyberpunkTheme, "day")["--tv-scene-bg"];
    await vi.waitFor(() => expect(hex(view.scene.background)).toBe(day));
    view.controller.setTime(MIDNIGHT);
    const night = resolveTokens(cyberpunkTheme, "night")["--tv-scene-bg"];
    await vi.waitFor(() => expect(hex(view.scene.background)).toBe(night));
  });

  it("switching the theme while it is night applies the new theme's night palette", async () => {
    registry.push(altTheme);
    // setTheme only knows themes present when the controller was built, so set the state directly.
    const view = await mount(lightingAt(MIDNIGHT));
    const cyberNight = resolveTokens(cyberpunkTheme, "night")["--tv-scene-bg"];
    await vi.waitFor(() => expect(hex(view.scene.background)).toBe(cyberNight));
    themeController.store.setState({
      themeId: ALT_ID,
      tokens: resolveTokens(altTheme, themeController.store.getState().mode),
    });
    await vi.waitFor(() => expect(hex(view.scene.background)).toBe("#2a0a3a"));
    // Still night lighting, and no day sky leaked in.
    expect(view.sun().intensity).toBeCloseTo(NIGHT_SUN, 3);
  });
});
