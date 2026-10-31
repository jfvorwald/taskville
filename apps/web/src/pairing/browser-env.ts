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
