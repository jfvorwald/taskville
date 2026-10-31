import { describe, expect, it, vi } from "vitest";
import { createAnchorSource } from "../../../src/overlays/host/anchors.ts";
import { createOverlayProps, type OverlayHostContext } from "../../../src/overlays/host/props.ts";

class MemoryStorage {
  items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
}

function context(over: Partial<OverlayHostContext> = {}): OverlayHostContext {
  return {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId: null, select: () => {} },
    anchors: createAnchorSource(),
    runIntent: () => {},
    storage: new MemoryStorage(),
    ...over,
  };
}

describe("createOverlayProps: intents", () => {
  it("forwards intents in live mode", () => {
    const runIntent = vi.fn();
    const props = createOverlayProps("agent-panel", context({ runIntent }));
    props.intents.run({ type: "agent.pause", agentId: "a" });
    expect(runIntent).toHaveBeenCalledWith({ type: "agent.pause", agentId: "a" });
    expect(props.intents.available).toBe(true);
  });

  it("drops intents in history mode, where nothing may change the live world", () => {
    const runIntent = vi.fn();
    const props = createOverlayProps("agent-panel", context({ mode: "history", runIntent }));
    props.intents.run({ type: "agent.pause", agentId: "a" });
    expect(runIntent).not.toHaveBeenCalled();
    expect(props.intents.available).toBe(false);
    expect(props.mode).toBe("history");
  });
});

describe("createOverlayProps: namespaced settings", () => {
  it("reads a fallback until a value is set, then persists under the overlay's namespace", () => {
    const storage = new MemoryStorage();
    const props = createOverlayProps("settings", context({ storage }));
    expect(props.settings.get("density", "cozy")).toBe("cozy");
    props.settings.set("density", "compact");
    expect(props.settings.get("density", "cozy")).toBe("compact");
    expect([...storage.items.keys()]).toEqual(["taskville.overlay.settings.density"]);
  });

  it("keeps two overlays' settings apart", () => {
    const storage = new MemoryStorage();
    createOverlayProps("one", context({ storage })).settings.set("k", 1);
    expect(createOverlayProps("two", context({ storage })).settings.get("k", 0)).toBe(0);
    expect(createOverlayProps("one", context({ storage })).settings.get("k", 0)).toBe(1);
  });

  it("falls back on unreadable stored values and survives a storage that throws", () => {
    const storage = new MemoryStorage();
    storage.setItem("taskville.overlay.o.k", "{not json");
    const props = createOverlayProps("o", context({ storage }));
    expect(props.settings.get("k", "fallback")).toBe("fallback");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const safe = createOverlayProps("o", context({ storage: broken }));
    expect(() => safe.settings.set("k", 1)).not.toThrow();
    expect(safe.settings.get("k", 7)).toBe(7);
  });

  it("works with no storage at all", () => {
    const props = createOverlayProps("o", context({ storage: null }));
    props.settings.set("k", 2);
    expect(props.settings.get("k", 0)).toBe(0);
  });
});

describe("createOverlayProps: pass-through", () => {
  it("hands overlays the shared selectors, selection and anchors", () => {
    const ctx = context();
    const props = createOverlayProps("x", ctx);
    expect(props.selectors).toBe(ctx.selectors);
    expect(props.selection).toBe(ctx.selection);
    expect(props.anchors).toBe(ctx.anchors);
  });
});
