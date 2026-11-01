import { createStore, type StoreApi } from "zustand/vanilla";
import {
  resolveTokens,
  type ThemeDefinition,
  type ThemeId,
  type ThemeMode,
  type ThemeTokens,
} from "./contract.ts";

/** The slice of an element the controller writes to (the document root in the app). */
export interface ThemeRoot {
  style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
}

export interface ThemeState {
  themeId: ThemeId;
  mode: ThemeMode;
  /** True while history is shown; themes tint and desaturate the city. */
  history: boolean;
  /** The resolved token set for `themeId` and `mode`. */
  tokens: ThemeTokens;
}

export interface ThemeController {
  store: StoreApi<ThemeState>;
  themes: readonly ThemeDefinition[];
  theme(): ThemeDefinition;
  /** Returns false (and changes nothing) for an id that is not registered. */
  setTheme(id: string): boolean;
  setMode(mode: ThemeMode): void;
  setHistory(history: boolean): void;
  /** Publishes the state on `root` now and on every change. Returns the detach function. */
  attach(root: ThemeRoot): () => void;
}

export interface ThemeControllerOptions {
  themes: readonly ThemeDefinition[];
  /** Default: the first theme. */
  initialThemeId?: ThemeId;
  initialMode?: ThemeMode;
}

/**
 * The theme state, kept apart from the data store on purpose: switching a theme writes here and
 * to the DOM only, so task state, selection, camera and history position are never touched.
 */
export function createThemeController(options: ThemeControllerOptions): ThemeController {
  const { themes } = options;
  const first = themes[0];
  if (first === undefined) throw new Error("createThemeController needs at least one theme");
  const byId = new Map(themes.map((t) => [t.id as string, t]));
  const start = byId.get(options.initialThemeId ?? first.id) ?? first;
  const mode0 = options.initialMode ?? "day";
  const store = createStore<ThemeState>(() => ({
    themeId: start.id,
    mode: mode0,
    history: false,
    tokens: resolveTokens(start, mode0),
  }));

  const theme = () => byId.get(store.getState().themeId) ?? first;
  const refresh = (patch: Partial<Pick<ThemeState, "themeId" | "mode" | "history">>) => {
    const next = { ...store.getState(), ...patch };
    const def = byId.get(next.themeId) ?? first;
    const current = store.getState();
    const unchanged = next.themeId === current.themeId && next.mode === current.mode;
    store.setState({ ...next, tokens: unchanged ? current.tokens : resolveTokens(def, next.mode) });
  };

  return {
    store,
    themes,
    theme,
    setTheme(id) {
      if (!byId.has(id)) return false;
      refresh({ themeId: id as ThemeId });
      return true;
    },
    setMode: (mode) => refresh({ mode }),
    setHistory: (history) => refresh({ history }),
    attach(root) {
      const publish = (s: ThemeState) => {
        for (const [name, value] of Object.entries(s.tokens)) root.style.setProperty(name, value);
        root.setAttribute("data-theme", s.themeId);
        root.setAttribute("data-mode", s.mode);
        root.setAttribute("data-history", String(s.history));
      };
      publish(store.getState());
      return store.subscribe(publish);
    },
  };
}
