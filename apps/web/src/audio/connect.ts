import type { Attention, StoredEnvelope } from "../data/domain.ts";
import type { Soundscape } from "./soundscape.ts";

/** What the soundscape listens to: the data store's attention and events, and the theme state. */
export interface SoundscapeSources {
  data: {
    getState(): { attention: readonly Attention[] };
    subscribe(
      listener: (
        state: { attention: readonly Attention[] },
        prev: { attention: readonly Attention[] },
      ) => void,
    ): () => void;
    onEvent(listener: (event: StoredEnvelope) => void): () => void;
  };
  theme: {
    getState(): { themeId: string; history: boolean };
    subscribe(
      listener: (
        state: { themeId: string; history: boolean },
        prev: { themeId: string; history: boolean },
      ) => void,
    ): () => void;
  };
}

/**
 * Feeds live attention, live events and the current theme to the soundscape. Nothing sounds until
 * the viewer enables sound. Returns the disposer.
 */
export function connectSoundscape(soundscape: Soundscape, { data, theme }: SoundscapeSources) {
  const first = theme.getState();
  soundscape.setTheme(first.themeId);
  soundscape.setHistory(first.history);
  soundscape.update(data.getState().attention);

  const offAttention = data.subscribe((state, prev) => {
    if (state.attention !== prev.attention) soundscape.update(state.attention);
  });
  const offEvents = data.onEvent((event) => soundscape.handleEvent(event));
  const offTheme = theme.subscribe((state, prev) => {
    if (state.themeId !== prev.themeId) soundscape.setTheme(state.themeId);
    if (state.history !== prev.history) soundscape.setHistory(state.history);
  });
  return () => {
    offAttention();
    offEvents();
    offTheme();
  };
}
