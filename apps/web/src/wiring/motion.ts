import type { Selector } from "../overlays/host/index.ts";
import { resolveReducedMotion, type SettingsStore } from "../overlays/settings/index.ts";

const QUERY = "(prefers-reduced-motion: reduce)";

/** The slice of `window.matchMedia` this needs. */
export interface MediaQueryLike {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/** The OS `prefers-reduced-motion` as a selector. False when there is no `matchMedia`. */
export function systemReducedMotion(
  matchMedia: ((query: string) => MediaQueryLike) | undefined,
): Selector<boolean> {
  const media = matchMedia?.(QUERY);
  return {
    getSnapshot: () => media?.matches ?? false,
    subscribe(listener) {
      media?.addEventListener("change", listener);
      return () => media?.removeEventListener("change", listener);
    },
  };
}

/**
 * Whether motion is reduced: the viewer's setting resolved against the OS preference with
 * `resolveReducedMotion`. Listeners hear about a change in the resolved value only.
 */
export function reducedMotionSelector(
  settings: Pick<SettingsStore, "getSnapshot" | "subscribe">,
  system: Selector<boolean>,
): Selector<boolean> {
  const getSnapshot = () =>
    resolveReducedMotion(settings.getSnapshot().reducedMotion, system.getSnapshot());
  return {
    getSnapshot,
    subscribe(listener) {
      let last = getSnapshot();
      const onChange = () => {
        const next = getSnapshot();
        if (next === last) return;
        last = next;
        listener();
      };
      const offSettings = settings.subscribe(onChange);
      const offSystem = system.subscribe(onChange);
      return () => {
        offSettings();
        offSystem();
      };
    },
  };
}
