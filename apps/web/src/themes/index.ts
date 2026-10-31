/**
 * Theme system placeholder (M3.07 and the theme tickets own this folder). One token set per
 * theme, shared by the DOM (CSS custom properties) and 3D materials (this reader).
 */
export function readCssToken(name: `--${string}`, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}
