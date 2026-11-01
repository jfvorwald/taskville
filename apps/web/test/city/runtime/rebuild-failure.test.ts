import { describe, expect, it } from "vitest";
import type { Navigator } from "../../../src/city/movement/navigator.ts";
import { rebuildPresentation } from "../../../src/city/runtime/rebuild.ts";

// M3.14 confirm-review nit: rebuildPresentation forces reduced motion on for one tick. If the tick
// throws, the user's own preference must still be put back, or reduced motion stays forced on.

function fakeNavigator(tickError: Error) {
  const calls: boolean[] = [];
  const nav = {
    setReducedMotion: (value: boolean) => {
      calls.push(value);
    },
    tick: () => {
      throw tickError;
    },
  } as unknown as Navigator;
  return { nav, calls };
}

describe("rebuildPresentation when the tick throws", () => {
  it("rethrows the error and restores a reduced-motion preference of false", () => {
    const boom = new Error("tick failed");
    const { nav, calls } = fakeNavigator(boom);
    expect(() => rebuildPresentation(nav, 60_000, false, 60_000)).toThrow(boom);
    expect(calls[0]).toBe(true);
    expect(calls.at(-1)).toBe(false);
  });

  it("rethrows the error and restores a reduced-motion preference of true", () => {
    const boom = new Error("tick failed");
    const { nav, calls } = fakeNavigator(boom);
    expect(() => rebuildPresentation(nav, 60_000, true, 60_000)).toThrow(boom);
    expect(calls.at(-1)).toBe(true);
  });
});
