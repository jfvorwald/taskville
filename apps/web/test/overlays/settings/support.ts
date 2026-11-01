import { vi } from "vitest";

export const KEY = (name: string) => `taskville.overlay.settings-panel.${name}`;

export function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

/**
 * A stand-in for `window` in the node test environment: a real EventTarget (so
 * `addEventListener("storage", ...)` works) with an optional `localStorage` property, which may
 * be a throwing getter. Installed with `vi.stubGlobal`; undo with `vi.unstubAllGlobals()`.
 */
export function stubWindow(localStorage?: { get: () => unknown } | object) {
  const win = new EventTarget();
  if (localStorage && "get" in localStorage && typeof localStorage.get === "function") {
    Object.defineProperty(win, "localStorage", { get: localStorage.get as () => unknown });
  } else if (localStorage) {
    Object.defineProperty(win, "localStorage", { value: localStorage });
  }
  vi.stubGlobal("window", win);
  return win;
}

/** What a browser delivers to the other tabs when one tab writes `key` in local storage. */
export function dispatchStorage(
  win: EventTarget,
  init: { key: string | null; newValue: string | null; storageArea?: unknown },
) {
  win.dispatchEvent(Object.assign(new Event("storage"), init));
}
