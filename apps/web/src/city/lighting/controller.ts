import { createStore, type StoreApi } from "zustand/vanilla";
import type { ThemeMode } from "../../themes/core/contract.ts";
import { browserTimeZone, computeLighting, type LightingState, localMinutes } from "./phase.ts";

/** Cycle follows the clock; the other two hold the city in day or night. */
export type LightingSetting = "cycle" | "always-day" | "always-night";
export const LIGHTING_SETTINGS: readonly LightingSetting[] = [
  "cycle",
  "always-day",
  "always-night",
];

/**
 * The small typed surface the settings panel (M3.15) drives. It does not import from this
 * folder: the lead passes it this shape as props.
 */
export interface LightingControl {
  setting: LightingSetting;
  setSetting(setting: LightingSetting): void;
}

/** The part of the theme controller lighting needs: it only sets day or night. */
export interface ThemeModeTarget {
  setMode(mode: ThemeMode): void;
}

export interface LightingSnapshot {
  setting: LightingSetting;
  /** Injected instant (ms since epoch) for history replay, or null to follow the clock. */
  time: number | null;
  /** The resolved lighting for the setting and time. */
  state: LightingState;
}

export interface TimerHooks {
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: never) => void;
}

export interface LightingControllerOptions {
  theme: ThemeModeTarget;
  /** The clock, ms since epoch. Default `Date.now`. */
  now?: () => number;
  /** IANA zone. Default: the browser's. */
  timeZone?: string;
  initialSetting?: LightingSetting;
}

export interface LightingController {
  store: StoreApi<LightingSnapshot>;
  timeZone: string;
  getSetting(): LightingSetting;
  setSetting(setting: LightingSetting): void;
  /** The instant used for lighting: the injected time when set, else the clock. */
  getTime(): number | null;
  /** Inject an instant (history replay, M6), or null to return to the clock. */
  setTime(instantMs: number | null): void;
  state(): LightingState;
  subscribe(listener: () => void): () => void;
  /** Re-read the clock and apply it. Cheap; called by the interval. */
  tick(): void;
  /** Start ticking (default every 30 s). Returns the stop function. */
  start(hooks?: TimerHooks): () => void;
}

const FIXED_DAY = computeLighting(12 * 60);
const FIXED_NIGHT = computeLighting(0);

function resolve(setting: LightingSetting, instantMs: number, timeZone: string): LightingState {
  if (setting === "always-day") return FIXED_DAY;
  if (setting === "always-night") return FIXED_NIGHT;
  return computeLighting(localMinutes(instantMs, timeZone));
}

const sameState = (a: LightingState, b: LightingState) =>
  a === b ||
  (a.phase === b.phase &&
    a.mode === b.mode &&
    Math.abs(a.nightness - b.nightness) < 1e-3 &&
    Math.abs(a.sunAngleDeg - b.sunAngleDeg) < 0.05);

/** Lighting state for the city: the setting, an optional injected time, and the clock. */
export function createLightingController(options: LightingControllerOptions): LightingController {
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone ?? browserTimeZone();
  const { theme } = options;
  const setting0 = options.initialSetting ?? "cycle";
  const store = createStore<LightingSnapshot>(() => ({
    setting: setting0,
    time: null,
    state: resolve(setting0, now(), timeZone),
  }));
  theme.setMode(store.getState().state.mode);

  const apply = (patch: Partial<Pick<LightingSnapshot, "setting" | "time">>) => {
    const prev = store.getState();
    const next = { ...prev, ...patch };
    const state = resolve(next.setting, next.time ?? now(), timeZone);
    const same = sameState(state, prev.state);
    if (patch.setting === undefined && patch.time === undefined && same) return;
    if (state.mode !== prev.state.mode) theme.setMode(state.mode);
    store.setState({ ...next, state: same ? prev.state : state });
  };

  return {
    store,
    timeZone,
    getSetting: () => store.getState().setting,
    setSetting: (setting) => apply({ setting }),
    getTime: () => store.getState().time,
    setTime: (time) => apply({ time }),
    state: () => store.getState().state,
    subscribe: (listener) => store.subscribe(listener),
    tick: () => apply({}),
    start(hooks = {}) {
      const set = hooks.setInterval ?? ((fn, ms) => setInterval(fn, ms));
      const clear = hooks.clearInterval ?? ((id) => clearInterval(id as never));
      const id = set(() => apply({}), hooks.intervalMs ?? 30_000);
      return () => clear(id as never);
    },
  };
}
