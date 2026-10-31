/**
 * The 3D city, mounted inside the scene's `<Canvas>`. Later tickets add their component here
 * with a one-line edit (an import and one element). The grid is scaffold only; M3.04 removes it.
 */
export function CityRoot() {
  return <gridHelper args={[24, 24, "#3a4558", "#252c38"]} />;
}
