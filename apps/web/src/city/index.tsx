import { ThemedCity } from "../themes/core/index.ts";

/**
 * The 3D city, mounted inside the scene's `<Canvas>`. Later tickets add their component here
 * with a one-line edit (an import and one element).
 */
export function CityRoot() {
  return <ThemedCity />;
}
