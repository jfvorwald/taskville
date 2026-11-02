import { Canvas } from "@react-three/fiber";
import type { DirectionalLight, HemisphereLight, Scene } from "three";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { CityRoot } from "../../city/index.tsx";
import { lightingController } from "../../city/lighting/instance.ts";
import {
  DAY_AMBIENT,
  DAY_SUN,
  localMinutes,
  NIGHT_AMBIENT,
  NIGHT_SUN,
} from "../../city/lighting/phase.ts";
import { createDataStore } from "../../data/store.ts";
import { worldAnchors } from "../../overlays/host/index.ts";
import { themeController } from "../../themes/core/index.ts";

const originalTheme = themeController.store.getState();
const originalSetting = lightingController.getSetting();
const originalTime = lightingController.getTime();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  lightingController.setSetting(originalSetting);
  lightingController.setTime(originalTime);
  themeController.setTheme(originalTheme.themeId);
  themeController.setHistory(originalTheme.history);
  themeController.setMode(originalTheme.mode);
  worldAnchors.replaceAnchors("agent:", {});
});

it("real CityRoot lights follow recorded local midnight/noon seeks and return to the wall clock", async () => {
  // Construct local instants in the browser's zone, rather than assuming UTC means local noon.
  const midnight = new Date(2026, 9, 30, 0, 0).getTime();
  const noon = new Date(2026, 9, 30, 12, 0).getTime();
  expect(localMinutes(midnight, lightingController.timeZone)).toBe(0);
  expect(localMinutes(noon, lightingController.timeZone)).toBe(720);
  lightingController.setSetting("cycle");
  lightingController.setTime(null);
  lightingController.tick();
  const wall = lightingController.state();
  // Enter at the phase opposite the real wall clock, so missing wiring always fails.
  const first = wall.nightness >= 0.5 ? noon : midnight;
  const second = first === noon ? midnight : noon;
  const store = createDataStore();
  let scene: Scene | undefined;
  const frame = (mode: "live" | "history", historyTime: number | null) => (
    <div style={{ width: 400, height: 300 }}>
      <Canvas
        camera={{ position: [16, 14, 16] }}
        onCreated={(s) => {
          scene = s.scene;
        }}
      >
        <CityRoot store={store} mode={mode} historyTime={historyTime} />
      </Canvas>
    </div>
  );
  const view = await render(frame("live", null));
  cleanups.push(() => view.unmount());
  const sun = () => scene?.getObjectByName("lighting-sun") as DirectionalLight | undefined;
  const ambient = () =>
    scene?.getObjectByName("lighting-hemisphere") as HemisphereLight | undefined;
  await expect.poll(() => sun()?.intensity).toBeCloseTo(wall.sunIntensity, 3);
  async function recorded(at: number) {
    await view.rerender(frame("history", at));
    await expect.poll(() => sun()?.intensity).toBeCloseTo(at === noon ? DAY_SUN : NIGHT_SUN, 3);
    expect(ambient()?.intensity).toBeCloseTo(at === noon ? DAY_AMBIENT : NIGHT_AMBIENT, 3);
    expect(lightingController.getTime()).toBe(at);
  }
  await recorded(first);
  await recorded(second);
  await view.rerender(frame("live", null));
  await expect.poll(() => lightingController.getTime()).toBeNull();
  await expect.poll(() => sun()?.intensity).toBeCloseTo(lightingController.state().sunIntensity, 3);
  await recorded(first);
  cleanups.pop();
  await view.unmount();
  expect(lightingController.getTime()).toBeNull();
});
