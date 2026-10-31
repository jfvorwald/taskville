import { describe, expect, it, vi } from "vitest";
import {
  areaSelectionId,
  createSelectionStore,
  parseSelectionId,
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
