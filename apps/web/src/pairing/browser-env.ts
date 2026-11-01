import { readPairingCode } from "./fragment.ts";
import type { PairingEnv } from "./pair.ts";

/**
 * The page's real browser pieces. Storage is reached through `window.localStorage` on every
 * call, not once here: a browser that blocks site storage throws on the property access, and
 * that has to land inside the pairing code's own storage error handling.
 */
export function browserEnv(): PairingEnv {
  return {
    location: window.location,
    history: window.history,
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
      removeItem: (key) => window.localStorage.removeItem(key),
    },
    fetch: window.fetch.bind(window),
  };
}

/**
 * Calls `onFresh` when a pairing fragment arrives after load. Pasting a new link into the tab
 * that is showing "Not paired" changes only the fragment, which does not reload the page.
 * Returns a function that stops listening. The fragment's own clearing carries no code and is
 * ignored.
 */
export function watchPairingFragment(
  target: Pick<Window, "addEventListener" | "removeEventListener"> & {
    location: { hash: string };
  },
  onFresh: () => void,
): () => void {
  const listener = () => {
    if (readPairingCode(target.location.hash).present) onFresh();
  };
  target.addEventListener("hashchange", listener);
  return () => target.removeEventListener("hashchange", listener);
}
