// The ambient loops, one file per theme (see ASSETS.md). Each is its own lazy chunk of the build,
// fetched only when the soundscape asks for that theme after the viewer turned sound on.

const LOOP_URLS = import.meta.glob("./ambient-*.wav", {
  query: "?url",
  import: "default",
}) as Record<string, () => Promise<string>>;

const cache = new Map<string, Promise<ArrayBuffer>>();

/** The encoded loop for a theme. Rejects when the theme has no loop file. */
export function loadAmbientLoop(themeId: string): Promise<ArrayBuffer> {
  const cached = cache.get(themeId);
  if (cached) return cached;
  const importUrl = LOOP_URLS[`./ambient-${themeId}.wav`];
  if (!importUrl) return Promise.reject(new Error(`no ambient loop for theme ${themeId}`));
  const pending = importUrl()
    .then((url) => fetch(url))
    .then((response) => {
      if (!response.ok) throw new Error(`ambient loop ${themeId}: ${response.status}`);
      return response.arrayBuffer();
    });
  cache.set(themeId, pending);
  // A failed fetch is not remembered, so the next request tries again.
  pending.catch(() => cache.delete(themeId));
  return pending;
}
