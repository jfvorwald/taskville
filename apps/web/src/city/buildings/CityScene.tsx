import { CITY_LAYOUT, type CityLayout } from "../layout/index.ts";
import { Buildings } from "./Buildings.tsx";
import { CityCamera } from "./CityCamera.tsx";
import { Ground } from "./Ground.tsx";
import { useCityMaterials } from "./materials.ts";
import { type CityPalette, DEFAULT_CITY_PALETTE } from "./palette.ts";
import { Scenery } from "./Scenery.tsx";

/**
 * The static city: camera, light, ground, streets, plaza, buildings and scenery, drawn from the
 * layout data. Agents (M3.05) mount beside it. The scene root already supplies ambient light.
 */
export function CityScene({
  layout = CITY_LAYOUT,
  palette = DEFAULT_CITY_PALETTE,
}: {
  layout?: CityLayout;
  palette?: CityPalette;
}) {
  const materials = useCityMaterials(palette);
  return (
    <group name="city">
      <CityCamera />
      <directionalLight position={[-12, 24, 16]} intensity={1.4} />
      <Ground layout={layout} materials={materials} />
      <Buildings layout={layout} materials={materials} />
      <Scenery layout={layout} materials={materials} />
    </group>
  );
}
