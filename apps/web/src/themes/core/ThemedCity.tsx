import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { Color } from "three";
import { CityScene } from "../../city/buildings/index.ts";
import { CITY_LAYOUT } from "../../city/layout/index.ts";
import { applyHistoryTint, cityPaletteFromTokens, tintHex } from "./contract.ts";
import type { ThemeController } from "./controller.ts";
import { useTheme } from "./react.ts";
import { ThemeAccents } from "./ThemeAccents.tsx";
import { themeController } from "./themes.ts";

/**
 * The city in the active theme. Publishes the theme's tokens on the document root (so the DOM
 * and this scene read one set), draws `CityScene` with the palette built from those tokens, adds
 * the theme's accents, and keeps the scene background in step. Mount it where `<CityScene />` was.
 */
export function ThemedCity({ controller = themeController }: { controller?: ThemeController }) {
  const themeId = useTheme((s) => s.themeId, controller);
  const tokens = useTheme((s) => s.tokens, controller);
  const history = useTheme((s) => s.history, controller);
  const theme = controller.themes.find((t) => t.id === themeId) ?? controller.theme();
  const scene = useThree((s) => s.scene);

  useLayoutEffect(() => controller.attach(document.documentElement), [controller]);

  const amount = history ? theme.history.desaturate : 0;
  const palette = useMemo(
    () => applyHistoryTint(cityPaletteFromTokens(tokens), theme.history.tint, amount),
    [tokens, theme, amount],
  );
  const neon = useMemo(
    () => tintHex(tokens["--tv-neon"], theme.history.tint, amount),
    [tokens, theme, amount],
  );
  const background = tintHex(tokens["--tv-scene-bg"], theme.history.tint, amount);
  useEffect(() => {
    const previous = scene.background;
    scene.background = new Color(background);
    return () => {
      scene.background = previous;
    };
  }, [scene, background]);

  return (
    <>
      <CityScene palette={palette} />
      <ThemeAccents layout={CITY_LAYOUT} accents={theme.accents} palette={palette} neon={neon} />
    </>
  );
}
