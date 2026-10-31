import { useStore } from "zustand";
import type { ThemeId, ThemeMode } from "./contract.ts";
import type { ThemeController, ThemeState } from "./controller.ts";
import { themeController } from "./themes.ts";

/** Reads the theme state. Select narrowly: `useTheme((s) => s.themeId)`. */
export function useTheme<T>(
  selector: (state: ThemeState) => T,
  controller: ThemeController = themeController,
): T {
  return useStore(controller.store, selector);
}

/**
 * What a theme picker needs, with no import of the theme internals. M3.15 (settings) takes this
 * shape as props; the lead wires `useThemeControl()` to it.
 */
export interface ThemeControl {
  themes: ReadonlyArray<{ id: ThemeId; name: string }>;
  activeId: ThemeId;
  setTheme(id: ThemeId): void;
  mode: ThemeMode;
  setMode(mode: ThemeMode): void;
}

export function useThemeControl(controller: ThemeController = themeController): ThemeControl {
  const activeId = useTheme((s) => s.themeId, controller);
  const mode = useTheme((s) => s.mode, controller);
  return {
    themes: controller.themes.map((t) => ({ id: t.id, name: t.name })),
    activeId,
    setTheme: (id) => void controller.setTheme(id),
    mode,
    setMode: controller.setMode,
  };
}
