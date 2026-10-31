import type { ThemeDefinition } from "../../../src/themes/core/index.ts";
import { cyberpunkTheme } from "../../../src/themes/cyberpunk/index.ts";

/** A second theme for switching tests: cyberpunk's tokens with a few values changed. */
export const otherTheme: ThemeDefinition = {
  ...cyberpunkTheme,
  id: "steampunk",
  name: "Steampunk (test fixture)",
  tokens: { ...cyberpunkTheme.tokens, "--tv-scene-bg": "#efe3cf", "--tv-city-wall": "#c8a27a" },
  night: {},
};
