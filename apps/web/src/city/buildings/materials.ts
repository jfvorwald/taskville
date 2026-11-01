import { useEffect, useMemo } from "react";
import { MeshBasicMaterial, MeshLambertMaterial } from "three";
import type { CityPalette } from "./palette.ts";

export interface CityMaterials {
  lambert: Record<keyof CityPalette, MeshLambertMaterial>;
  windowGlow: MeshBasicMaterial;
  lampGlow: MeshBasicMaterial;
}

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
