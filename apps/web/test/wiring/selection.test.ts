import { describe, expect, it } from "vitest";
import { areaSelectionId, createSelectionStore } from "../../src/city/interaction/selection.ts";
import { createDataStore } from "../../src/data/store.ts";
import { connectSelectedAgent, overlaySelection } from "../../src/wiring/selection.ts";

describe("one selection source for the selector and the overlay host", () => {
  it("shows the selector's value as the overlay host's selection", () => {
    const store = createSelectionStore();
    const overlay = overlaySelection(store);
    expect(overlay.getSnapshot().selectedId).toBeNull();

    store.select("agent-1");
    expect(overlay.getSnapshot().selectedId).toBe("agent-1");
    store.select(areaSelectionId("workshop"));
    expect(overlay.getSnapshot().selectedId).toBe("area:workshop");
  });

  it("writes an overlay's select() into the same selector", () => {
    const store = createSelectionStore();
    const overlay = overlaySelection(store);
    overlay.getSnapshot().select("agent-2");
    expect(store.getSnapshot()).toBe("agent-2");
    expect(overlay.getSnapshot().selectedId).toBe("agent-2");
    overlay.getSnapshot().select(null);
    expect(store.getSnapshot()).toBeNull();
  });

  it("notifies subscribers on change and keeps the same snapshot until it changes", () => {
    const store = createSelectionStore();
    const overlay = overlaySelection(store);
    let calls = 0;
    const off = overlay.subscribe(() => calls++);
    const first = overlay.getSnapshot();
    expect(overlay.getSnapshot()).toBe(first);

    store.select("a");
    expect(calls).toBe(1);
    const second = overlay.getSnapshot();
    expect(second).not.toBe(first);
    expect(overlay.getSnapshot()).toBe(second);
    // select() keeps its identity across snapshots, so overlays can hold it.
    expect(second.select).toBe(first.select);

    store.select("a");
    expect(calls).toBe(1);
    off();
    store.select("b");
    expect(calls).toBe(1);
  });
});

describe("the data store's selectedAgentId follows agent selections", () => {
  it("mirrors agent ids and null, and applies the current selection on connect", () => {
    const selection = createSelectionStore("agent-0");
    const data = createDataStore();
    const off = connectSelectedAgent({ selection, data });
    expect(data.getState().selectedAgentId).toBe("agent-0");

    selection.select("agent-1");
    expect(data.getState().selectedAgentId).toBe("agent-1");
    selection.select(null);
    expect(data.getState().selectedAgentId).toBeNull();
    off();
  });

  it("ignores area: selections", () => {
    const selection = createSelectionStore();
    const data = createDataStore();
    const off = connectSelectedAgent({ selection, data });
    selection.select("agent-1");
    selection.select(areaSelectionId("archives"));
    expect(data.getState().selectedAgentId).toBe("agent-1");
    off();
  });

  it("does not follow once disposed", () => {
    const selection = createSelectionStore();
    const data = createDataStore();
    const off = connectSelectedAgent({ selection, data });
    off();
    selection.select("agent-9");
    expect(data.getState().selectedAgentId).toBeNull();
  });
});
