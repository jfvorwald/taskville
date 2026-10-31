import { useStore } from "zustand";
import type { LightingControl, LightingController, LightingSnapshot } from "./controller.ts";
import { lightingController } from "./instance.ts";

export function useLighting<T>(
  selector: (snapshot: LightingSnapshot) => T,
  controller: LightingController = lightingController,
): T {
  return useStore(controller.store, selector);
}

/** What the settings panel (M3.15) takes as props. */
export function useLightingControl(
  controller: LightingController = lightingController,
): LightingControl {
  const setting = useLighting((s) => s.setting, controller);
  return { setting, setSetting: controller.setSetting };
}
