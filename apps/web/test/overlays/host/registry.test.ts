import { describe, expect, it, vi } from "vitest";
import { createOverlayRegistry, resolveActiveOverlays } from "../../../src/overlays/host/registry.ts";
import type { OverlayDefinition } from "../../../src/overlays/host/types.ts";

const Nothing = () => null;

function def(
  id: string,
  slot: OverlayDefinition["slot"],
  modes: OverlayDefinition["modes"] = ["live", "history"],
): OverlayDefinition {
  return { id, slot, modes, Component: Nothing };
}

describe("overlay registry", () => {
  it("lists overlays in registration order and finds them by id", () => {
    const registry = createOverlayRegistry();
    registry.register(def("a", "header"));
    registry.register(def("b", "sidebar"));
    expect(registry.list().map((d) => d.id)).toEqual(["a", "b"]);
    expect(registry.get("b")?.slot).toBe("sidebar");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("starts from an initial list", () => {
    const registry = createOverlayRegistry([def("a", "header"), def("b", "timeline")]);
    expect(registry.list().map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("refuses a duplicate id, an unknown slot and an empty mode list", () => {
    const registry = createOverlayRegistry([def("a", "header")]);
    expect(() => registry.register(def("a", "sidebar"))).toThrow(/already registered/);
    expect(() => registry.register(def("x", "nowhere" as never))).toThrow(/unknown slot/);
    expect(() => registry.register(def("y", "header", []))).toThrow(/at least one mode/);
    expect(registry.list()).toHaveLength(1);
  });

  it("unregisters, and the returned disposer removes only that overlay", () => {
    const registry = createOverlayRegistry();
    const dispose = registry.register(def("a", "header"));
    registry.register(def("b", "header"));
    dispose();
    expect(registry.list().map((d) => d.id)).toEqual(["b"]);
    dispose();
    expect(registry.list().map((d) => d.id)).toEqual(["b"]);
    registry.unregister("b");
    expect(registry.list()).toEqual([]);
  });

  it("notifies subscribers on change, with a new snapshot each time", () => {
    const registry = createOverlayRegistry();
    const listener = vi.fn();
    const stop = registry.subscribe(listener);
    const before = registry.list();
    registry.register(def("a", "header"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.list()).not.toBe(before);
    expect(registry.list()).toBe(registry.list());
    stop();
    registry.register(def("b", "header"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("resolveActiveOverlays: modes and slots", () => {
  const registry = createOverlayRegistry([
    def("counts", "header"),
    def("labels", "world-labels"),
    def("timeline", "timeline", ["history"]),
    def("quips", "bubbles", ["live"]),
  ]);

  it("returns every slot, empty when nothing is enabled", () => {
    const active = resolveActiveOverlays(registry.list(), { mode: "live", enabled: [] });
    expect(Object.keys(active).sort()).toEqual(
      ["bubbles", "header", "sidebar", "timeline", "world-labels"].sort(),
    );
    for (const list of Object.values(active)) expect(list).toEqual([]);
  });

  it("includes only enabled overlays that support the current mode", () => {
    const enabled = ["counts", "labels", "timeline", "quips"];
    const live = resolveActiveOverlays(registry.list(), { mode: "live", enabled });
    expect(live.header.map((d) => d.id)).toEqual(["counts"]);
    expect(live.timeline).toEqual([]);
    expect(live.bubbles.map((d) => d.id)).toEqual(["quips"]);
    const history = resolveActiveOverlays(registry.list(), { mode: "history", enabled });
    expect(history.timeline.map((d) => d.id)).toEqual(["timeline"]);
    expect(history.bubbles).toEqual([]);
  });

  it("ignores enabled ids that are not registered", () => {
    const active = resolveActiveOverlays(registry.list(), { mode: "live", enabled: ["ghost"] });
    expect(active.header).toEqual([]);
  });

  it("keeps several overlays in a slot that is not exclusive, in registration order", () => {
    const list = [def("a", "world-labels"), def("b", "world-labels")];
    const active = resolveActiveOverlays(list, { mode: "live", enabled: ["b", "a"] });
    expect(active["world-labels"].map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("resolveActiveOverlays: slot exclusivity", () => {
  const list = [def("agent-panel", "sidebar"), def("task-queue", "sidebar"), def("settings", "sidebar")];
  const enabled = ["agent-panel", "task-queue", "settings"];

  it("allows only one sidebar, the first enabled by default", () => {
    const active = resolveActiveOverlays(list, { mode: "live", enabled });
    expect(active.sidebar.map((d) => d.id)).toEqual(["agent-panel"]);
  });

  it("shows the chosen sidebar when it is enabled and in mode", () => {
    const active = resolveActiveOverlays(list, { mode: "live", enabled, sidebar: "settings" });
    expect(active.sidebar.map((d) => d.id)).toEqual(["settings"]);
  });

  it("falls back to the first candidate when the chosen sidebar is unavailable", () => {
    const withHistoryOnly = [def("agent-panel", "sidebar", ["live"]), def("evidence", "sidebar", ["history"])];
    const active = resolveActiveOverlays(withHistoryOnly, {
      mode: "history",
      enabled: ["agent-panel", "evidence"],
      sidebar: "agent-panel",
    });
    expect(active.sidebar.map((d) => d.id)).toEqual(["evidence"]);
  });

  it("shows no sidebar when none is enabled", () => {
    expect(resolveActiveOverlays(list, { mode: "live", enabled: [] }).sidebar).toEqual([]);
  });
});
