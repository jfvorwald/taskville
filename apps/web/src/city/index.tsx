import { ThemedCity } from "../themes/core/index.ts";
import { useReducedMotion } from "../wiring/index.ts";
import { InteractionLayer } from "./interaction/index.ts";
import { DayNightLighting } from "./lighting/index.ts";
import { CityAgents } from "./movement/index.ts";

/**
 * The 3D city, mounted inside the scene's `<Canvas>`. Later tickets add their component here
 * with a one-line edit (an import and one element). `DayNightLighting` comes after `ThemedCity`
 * on purpose: it owns the lights and the sky, and its background write must run second.
 */
export function CityRoot() {
  const reducedMotion = useReducedMotion();
  return (
    <>
      <ThemedCity />
      <DayNightLighting />
      <CityAgents reducedMotion={reducedMotion} />
      <InteractionLayer />
    </>
  );
}
