import { describe, expect, it } from "vitest";
import { areaSelectionId, createSelectionStore } from "../../src/city/interaction/selection.ts";
import { createDataStore } from "../../src/data/store.ts";
import { connectSelectedAgent } from "../../src/wiring/selection.ts";

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
