import { CityScene } from "./buildings/index.ts";
import { InteractionLayer } from "./interaction/index.ts";
import { CityAgents } from "./movement/index.ts";

/**
 * The 3D city, mounted inside the scene's `<Canvas>`. Later tickets add their component here
 * with a one-line edit (an import and one element).
 */
export function CityRoot() {
  return (
    <>
      <CityScene />
      <CityAgents />
      <InteractionLayer />
    </>
  );
}
