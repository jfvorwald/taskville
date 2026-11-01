import { describe, expect, it, vi } from "vitest";
import { createPresentationEpoch } from "../../../src/city/runtime/epoch.ts";

// M3.14 code-review fix (B1). RenderPacer bumps this store when the tab returns from hidden, so
// CityAgents (which owns the navigator) can subscribe and call `rebuildPresentation` with how
// long the tab was hidden. It is a Selector: subscribe + a getSnapshot that is referentially
// stable until the next bump.

describe("presentationEpoch", () => {
  it("starts at epoch 0 with nothing hidden", () => {
    const e = createPresentationEpoch();
    expect(e.getSnapshot()).toEqual({ epoch: 0, hiddenForMs: 0 });
  });

  it("bump(hiddenForMs) advances the epoch and records how long the tab was hidden", () => {
    const e = createPresentationEpoch();
    e.bump(60_000);
    expect(e.getSnapshot()).toEqual({ epoch: 1, hiddenForMs: 60_000 });
    e.bump(500);
    expect(e.getSnapshot()).toEqual({ epoch: 2, hiddenForMs: 500 });
  });

  it("notifies subscribers on every bump, and not after unsubscribe", () => {
    const e = createPresentationEpoch();
    const listener = vi.fn();
    const off = e.subscribe(listener);
    e.bump(10);
    e.bump(20);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    e.bump(30);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns the same snapshot reference until the next bump", () => {
    const e = createPresentationEpoch();
    e.bump(5);
    expect(e.getSnapshot()).toBe(e.getSnapshot());
    const before = e.getSnapshot();
    e.bump(5);
    expect(e.getSnapshot()).not.toBe(before);
  });

  it("the snapshot is already updated when a listener runs", () => {
    const e = createPresentationEpoch();
    let seen = -1;
    e.subscribe(() => {
      seen = e.getSnapshot().epoch;
    });
    e.bump(1);
    expect(seen).toBe(1);
  });
});

describe("the app-wide presentationEpoch", () => {
  it("is exported from the module as a shared instance", async () => {
    const mod = await import("../../../src/city/runtime/epoch.ts");
    expect(typeof mod.presentationEpoch.bump).toBe("function");
    expect(typeof mod.presentationEpoch.subscribe).toBe("function");
    expect(mod.presentationEpoch.getSnapshot().epoch).toBeTypeOf("number");
  });
});
