/** Reads one CSS custom property from the document root, or `fallback` when it is unset. */
export function readCssToken(name: `--${string}`, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}
