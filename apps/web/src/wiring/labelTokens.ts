import type { ThemeController } from "../themes/core/index.ts";
import { readCssToken } from "../themes/core/index.ts";

/** The theme tokens an agent label draws with. */
export interface LabelTokens {
  font: string;
  text: string;
  muted: string;
}

type ReadToken = (name: `--${string}`, fallback: string) => string;

export function readLabelTokens(read: ReadToken = readCssToken): LabelTokens {
  return {
    font: read("--tv-font", "system-ui, sans-serif"),
    text: read("--tv-text", "#d7dce5"),
    muted: read("--tv-text-muted", "#8b94a5"),
  };
}

/**
 * Reports the label tokens now and again whenever the theme's tokens change (a theme switch or
 * day to night), so labels redraw in the new colours. Returns the disposer.
 */
export function watchLabelTokens(
  theme: Pick<ThemeController, "store">,
  onTokens: (tokens: LabelTokens) => void,
  read: ReadToken = readCssToken,
) {
  onTokens(readLabelTokens(read));
  return theme.store.subscribe((state, prev) => {
    if (state.tokens !== prev.tokens) onTokens(readLabelTokens(read));
  });
}
