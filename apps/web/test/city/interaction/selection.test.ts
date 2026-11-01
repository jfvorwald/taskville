import { describe, expect, it, vi } from "vitest";
import {
  areaSelectionId,
  createSelectionStore,
  parseSelectionId,
  selectionAfterRescan,
} from "../../../src/city/interaction/selection.ts";

describe("selection store", () => {
  it("starts empty and reports the selected id as a stable snapshot", () => {
    const store = createSelectionStore();
    expect(store.getSnapshot()).toBeNull();
    store.select("agent-1");
    expect(store.getSnapshot()).toBe("agent-1");
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("notifies subscribers only when the value changes", () => {
    const store = createSelectionStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.select("a");
    store.select("a");
    store.select(null);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.select("b");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("is usable as an overlay Selector (subscribe and getSnapshot only needed)", () => {
    const store = createSelectionStore("x");
    const selector: { subscribe(l: () => void): () => void; getSnapshot(): string | null } = store;
    expect(selector.getSnapshot()).toBe("x");
  });

  it("keeps building selections apart from agent ids", () => {
    expect(areaSelectionId("review")).toBe("area:review");
    expect(parseSelectionId("area:review")).toEqual({ kind: "area", id: "review" });
    expect(parseSelectionId("sess-42")).toEqual({ kind: "agent", id: "sess-42" });
    expect(parseSelectionId(null)).toBeNull();
  });
});

describe("selectionAfterRescan", () => {
  it("leaves a selection alone until its object has been seen once", () => {
    // A selection made from the agent list before the agent mounts must survive.
    expect(selectionAfterRescan({ seen: false, found: false })).toEqual({
      seen: false,
      clear: false,
    });
  });

  it("marks the object seen when the rescan finds it", () => {
    expect(selectionAfterRescan({ seen: false, found: true })).toEqual({
      seen: true,
      clear: false,
    });
  });

  it("keeps a seen object's selection while it is still found", () => {
    expect(selectionAfterRescan({ seen: true, found: true })).toEqual({
      seen: true,
      clear: false,
    });
  });

  it("clears the selection when an object that was seen is gone", () => {
    expect(selectionAfterRescan({ seen: true, found: false })).toEqual({
      seen: false,
      clear: true,
    });
  });
});
