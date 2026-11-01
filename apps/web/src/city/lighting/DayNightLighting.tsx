import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color } from "three";
import { resolveTokens, tintHex } from "../../themes/core/contract.ts";
import { themeController } from "../../themes/core/index.ts";
import { useTheme } from "../../themes/core/react.ts";
import { setSharedEmissiveLevel } from "../buildings/materials.ts";
import type { LightingController } from "./controller.ts";
import { emissiveLevel } from "./emissive.ts";
import { lightingController } from "./instance.ts";
import { useLighting } from "./react.ts";
import { lightRig } from "./skyColors.ts";

/**
 * The city's lights and sky, driven by the lighting controller: a hemisphere light (ambient),
 * one directional light (sun by day, moon at night) and the scene background. The theme's
 * window and lamp emissives follow `themeController.setMode`, which the controller sets, so they
 * switch from the theme's night palette. No post-processing. Mount it after `ThemedCity` so the
 * sky it sets in an effect wins over the theme's own background effect.
 */
export function DayNightLighting({
  controller = lightingController,
  start = true,
}: {
  controller?: LightingController;
  /** Tick the clock every 30 s. Tests and history pass false. */
  start?: boolean;
}) {
  const state = useLighting((s) => s.state, controller);
  const themeId = useTheme((s) => s.themeId);
  const history = useTheme((s) => s.history);
  const tokens = useTheme((s) => s.tokens);
  const scene = useThree((s) => s.scene);

  useEffect(() => (start ? controller.start() : undefined), [controller, start]);

  const rig = useMemo(() => {
    const theme = themeController.themes.find((t) => t.id === themeId) ?? themeController.theme();
    const r = lightRig(state, resolveTokens(theme, "day"), resolveTokens(theme, "night"));
    if (history) r.sky = tintHex(r.sky, theme.history.tint, theme.history.desaturate);
    return r;
  }, [state, themeId, history]);

  // The window and lamp glow follow nightness through one shared level, with no per-frame work.
  useEffect(() => {
    setSharedEmissiveLevel(emissiveLevel(state.nightness));
  }, [state.nightness]);

  // `tokens` is a dependency on purpose: ThemedCity resets the background whenever it changes,
  // and this effect runs after it in the same commit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokens re-triggers the sky write
  useEffect(() => {
    scene.background = new Color(rig.sky);
  }, [scene, rig.sky, tokens]);

  return (
    <>
      <hemisphereLight
        name="lighting-hemisphere"
        color={rig.hemisphereSky}
        groundColor={rig.hemisphereGround}
        intensity={rig.ambientIntensity}
      />
      <directionalLight
        name="lighting-sun"
        color={rig.sunColor}
        intensity={rig.sunIntensity}
        position={rig.sunPosition}
      />
    </>
  );
}
