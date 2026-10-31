import { useEffect, useMemo } from "react";
import { BoxGeometry, MeshBasicMaterial, MeshLambertMaterial } from "three";
import type { CityPalette } from "../../city/buildings/index.ts";
import type { CityLayout } from "../../city/layout/index.ts";
import type { ThemeAccent } from "./contract.ts";

/** Draws a theme's accents on the shared buildings. Boxes only, one shared unit geometry. */
export function ThemeAccents({
  layout,
  accents,
  palette,
  neon,
}: {
  layout: CityLayout;
  accents: readonly ThemeAccent[];
  palette: CityPalette;
  neon: string;
}) {
  const unit = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const materials = useMemo(() => {
    const cache = new Map<string, MeshBasicMaterial | MeshLambertMaterial>();
    for (const a of accents) {
      const color = a.tone === "neon" ? neon : palette[a.tone];
      const key = `${a.glow ? "b" : "l"}${color}`;
      if (!cache.has(key))
        cache.set(
          key,
          a.glow ? new MeshBasicMaterial({ color }) : new MeshLambertMaterial({ color }),
        );
    }
    return cache;
  }, [accents, palette, neon]);
  useEffect(
    () => () => {
      for (const m of materials.values()) m.dispose();
    },
    [materials],
  );
  const placed = useMemo(
    () =>
      layout.areas.flatMap((area) =>
        accents
          .filter((a) => a.areas === "all" || a.areas.includes(area.id))
          .map((a) => ({ area, a })),
      ),
    [layout, accents],
  );
  return (
    <group name="theme-accents">
      {placed.map(({ area, a }) => {
        const color = a.tone === "neon" ? neon : palette[a.tone];
        const material = materials.get(`${a.glow ? "b" : "l"}${color}`);
        if (material === undefined) return null;
        return (
          <mesh
            key={`${area.id}:${a.id}`}
            geometry={unit}
            material={material}
            position={[area.footprint.cx + a.x, a.y, area.footprint.cz + a.z]}
            scale={[a.sx, a.sy, a.sz]}
          />
        );
      })}
    </group>
  );
}
