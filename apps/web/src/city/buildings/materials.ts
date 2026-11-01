import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { MeshBasicMaterial, MeshLambertMaterial } from "three";
import type { CityPalette } from "./palette.ts";

export interface CityMaterials {
  lambert: Record<keyof CityPalette, MeshLambertMaterial>;
  windowGlow: MeshBasicMaterial;
  lampGlow: MeshBasicMaterial;
}

/**
 * Set the window and lamp glow to the palette color scaled by `level` (0..1, the shared emissive
 * level). Always computed from the palette, never the current color, so repeated calls do not
 * drift; level 1 is the palette hex. Allocation free, so it is safe to call as the level changes.
 */
export function applyEmissiveLevel(
  materials: Pick<CityMaterials, "windowGlow" | "lampGlow">,
  level: number,
  palette: CityPalette,
): void {
  materials.windowGlow.color.set(palette.windowGlow).multiplyScalar(level);
  materials.lampGlow.color.set(palette.lampGlow).multiplyScalar(level);
}

// The one shared emissive level. `DayNightLighting` publishes it; every city material set reads
// it. Full until the lighting publishes, so a city without lighting keeps the palette glow.
let sharedEmissiveLevel = 1;
const emissiveListeners = new Set<() => void>();

/** Publish the shared emissive level; the glow materials follow on the next commit. */
export function setSharedEmissiveLevel(level: number): void {
  if (level === sharedEmissiveLevel) return;
  sharedEmissiveLevel = level;
  for (const listener of emissiveListeners) listener();
}

function subscribeEmissiveLevel(listener: () => void): () => void {
  emissiveListeners.add(listener);
  return () => {
    emissiveListeners.delete(listener);
  };
}

const readEmissiveLevel = () => sharedEmissiveLevel;

/** Shared materials for the whole city, created once per palette and disposed on change. */
export function useCityMaterials(palette: CityPalette): CityMaterials {
  const materials = useMemo(() => {
    const lambert = {} as CityMaterials["lambert"];
    for (const key of Object.keys(palette) as Array<keyof CityPalette>) {
      lambert[key] = new MeshLambertMaterial({ color: palette[key] });
    }
    return {
      lambert,
      windowGlow: new MeshBasicMaterial({ color: palette.windowGlow }),
      lampGlow: new MeshBasicMaterial({ color: palette.lampGlow }),
    };
  }, [palette]);
  const level = useSyncExternalStore(subscribeEmissiveLevel, readEmissiveLevel);
  // A layout effect: materials made for a new palette are scaled before their first paint.
  useLayoutEffect(() => applyEmissiveLevel(materials, level, palette), [materials, level, palette]);
  useEffect(
    () => () => {
      for (const m of Object.values(materials.lambert)) m.dispose();
      materials.windowGlow.dispose();
      materials.lampGlow.dispose();
    },
    [materials],
  );
  return materials;
}
