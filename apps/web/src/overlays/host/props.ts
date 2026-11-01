import type {
  AnchorSource,
  OverlayIntent,
  OverlayMode,
  OverlayProps,
  OverlaySelection,
  OverlaySelectors,
  OverlaySettings,
} from "./types.ts";

/** The slice of `Storage` the settings need. `null` means no persistence (private mode, tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Everything the host knows once; each overlay gets its own `OverlayProps` cut from it. */
export interface OverlayHostContext {
  mode: OverlayMode;
  selectors: OverlaySelectors;
  selection: OverlaySelection;
  anchors: AnchorSource;
  /** Hands an intent to the command service. Only called in live mode. */
  runIntent(intent: OverlayIntent): void;
  storage: StorageLike | null;
}

export function createOverlayProps(overlayId: string, context: OverlayHostContext): OverlayProps {
  const live = context.mode === "live";
  return {
    mode: context.mode,
    selectors: context.selectors,
    selection: context.selection,
    anchors: context.anchors,
    intents: {
      available: live,
      run(intent) {
        if (live) context.runIntent(intent);
      },
    },
    settings: createSettings(overlayId, context.storage),
  };
}

function createSettings(overlayId: string, storage: StorageLike | null): OverlaySettings {
  const keyFor = (key: string) => `taskville.overlay.${overlayId}.${key}`;
  return {
    get<T>(key: string, fallback: T): T {
      try {
        const raw = storage?.getItem(keyFor(key));
        if (raw === null || raw === undefined) return fallback;
        const value: unknown = JSON.parse(raw);
        return typeof value === typeof fallback && (value === null) === (fallback === null)
          ? (value as T)
          : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        storage?.setItem(keyFor(key), JSON.stringify(value));
      } catch {
        // Storage can be full or blocked; a setting that does not stick is not worth a crash.
      }
    },
  };
}
