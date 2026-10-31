import { describe, expect, it, vi } from "vitest";
import { createNavigator } from "../../src/city/movement/navigator.ts";
import {
  connectReducedMotion,
  reducedMotionSelector,
  systemReducedMotion,
} from "../../src/wiring/motion.ts";
import { rig } from "./fixtures.ts";

/** A `matchMedia` stand-in whose answer the test flips. */
function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: initial,
    addEventListener: (_type: "change", fn: () => void) => void listeners.add(fn),
    removeEventListener: (_type: "change", fn: () => void) => void listeners.delete(fn),
  };
  return {
    matchMedia: vi.fn((_query: string) => media),
    set(next: boolean) {
      media.matches = next;
      for (const fn of [...listeners]) fn();
    },
    listenerCount: () => listeners.size,
  };
}

describe("system reduced motion selector", () => {
  it("reads prefers-reduced-motion and follows changes", () => {
    const media = fakeMedia(false);
    const system = systemReducedMotion(media.matchMedia);
    expect(media.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    const seen: boolean[] = [];
    const off = system.subscribe(() => seen.push(system.getSnapshot()));
    expect(system.getSnapshot()).toBe(false);
    media.set(true);
    expect(system.getSnapshot()).toBe(true);
    expect(seen).toEqual([true]);
    off();
    expect(media.listenerCount()).toBe(0);
  });

  it("is false when matchMedia does not exist", () => {
    expect(systemReducedMotion(undefined).getSnapshot()).toBe(false);
  });
});

describe("reduced motion setting resolves through resolveReducedMotion", () => {
  it("system follows the OS, on and off override it", () => {
    const { settings } = rig();
    const media = fakeMedia(true);
    const reduced = reducedMotionSelector(settings, systemReducedMotion(media.matchMedia));
    expect(reduced.getSnapshot()).toBe(true); // system, OS prefers reduced

    settings.set("reducedMotion", "off");
    expect(reduced.getSnapshot()).toBe(false);

    settings.set("reducedMotion", "system");
    media.set(false);
    expect(reduced.getSnapshot()).toBe(false);
    settings.set("reducedMotion", "on");
    expect(reduced.getSnapshot()).toBe(true);
  });

  it("notifies subscribers when the resolved value changes, from either source", () => {
    const { settings } = rig();
    const media = fakeMedia(false);
    const reduced = reducedMotionSelector(settings, systemReducedMotion(media.matchMedia));
    const seen: boolean[] = [];
    const off = reduced.subscribe(() => seen.push(reduced.getSnapshot()));

    settings.set("reducedMotion", "on");
    media.set(true); // system changed, but the setting is "on": still true
    settings.set("reducedMotion", "system"); // OS says reduce: still true
    media.set(false);
    expect(seen.at(0)).toBe(true);
    expect(seen.at(-1)).toBe(false);
    off();
    settings.set("reducedMotion", "on");
    expect(seen.at(-1)).toBe(false);
  });
});

describe("reduced motion reaches navigation", () => {
  it("pushes the resolved value into the navigator now and on every change", () => {
    const { settings } = rig();
    const media = fakeMedia(false);
    const reduced = reducedMotionSelector(settings, systemReducedMotion(media.matchMedia));
    const calls: boolean[] = [];
    const target = { setReducedMotion: (on: boolean) => void calls.push(on) };

    const off = connectReducedMotion(reduced, target);
    expect(calls).toEqual([false]);
    settings.set("reducedMotion", "on");
    expect(calls.at(-1)).toBe(true);
    settings.set("reducedMotion", "off");
    expect(calls.at(-1)).toBe(false);
    off();
    const count = calls.length;
    settings.set("reducedMotion", "on");
    expect(calls).toHaveLength(count);
  });

  it("accepts a real navigator as the target", () => {
    const { settings } = rig();
    const reduced = reducedMotionSelector(settings, systemReducedMotion(undefined));
    const nav = createNavigator();
    const spy = vi.spyOn(nav, "setReducedMotion");
    const off = connectReducedMotion(reduced, nav);
    settings.set("reducedMotion", "on");
    expect(spy).toHaveBeenLastCalledWith(true);
    off();
  });
});
