import { describe, expect, it, vi } from "vitest";
import { createAnchorSource } from "../../../src/overlays/host/anchors.ts";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("anchor source", () => {
  it("stores world anchors and removes them", () => {
    const source = createAnchorSource();
    source.setAnchor("agent:a", [1, 0, 2]);
    expect(source.getAnchor("agent:a")).toEqual([1, 0, 2]);
    source.removeAnchor("agent:a");
    expect(source.getAnchor("agent:a")).toBeUndefined();
  });

  it("notifies on change but not when the same position is set again", () => {
    const source = createAnchorSource();
    const listener = vi.fn();
    source.subscribe(listener);
    source.setAnchor("a", [1, 2, 3]);
    source.setAnchor("a", [1, 2, 3]);
    expect(listener).toHaveBeenCalledTimes(1);
    source.setAnchor("a", [1, 2, 4]);
    expect(listener).toHaveBeenCalledTimes(2);
    source.removeAnchor("missing");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("copies positions so a caller reusing its array cannot corrupt the store", () => {
    const source = createAnchorSource();
    const p: [number, number, number] = [1, 1, 1];
    source.setAnchor("a", p);
    p[0] = 99;
    expect(source.getAnchor("a")).toEqual([1, 1, 1]);
  });

  it("replaces all anchors of a prefix at once", () => {
    const source = createAnchorSource();
    source.setAnchor("agent:a", [0, 0, 0]);
    source.setAnchor("building:x", [5, 0, 5]);
    source.replaceAnchors("agent:", { "agent:b": [1, 1, 1] });
    expect(source.getAnchor("agent:a")).toBeUndefined();
    expect(source.getAnchor("agent:b")).toEqual([1, 1, 1]);
    expect(source.getAnchor("building:x")).toEqual([5, 0, 5]);
  });

  it("projects an anchor to screen space once a projection is set", () => {
    const source = createAnchorSource();
    source.setAnchor("a", [0, 0, 0]);
    expect(source.project("a")).toBeNull();
    source.setProjection(IDENTITY, { width: 200, height: 100 });
    expect(source.project("a")).toMatchObject({ x: 100, y: 50, visible: true });
    expect(source.project("unknown")).toBeNull();
  });

  it("notifies on projection change only when the camera or viewport really changed", () => {
    const source = createAnchorSource();
    const listener = vi.fn();
    source.subscribe(listener);
    source.setProjection(IDENTITY, { width: 200, height: 100 });
    source.setProjection([...IDENTITY], { width: 200, height: 100 });
    expect(listener).toHaveBeenCalledTimes(1);
    source.setProjection(IDENTITY, { width: 300, height: 100 });
    expect(listener).toHaveBeenCalledTimes(2);
    source.setProjection([2, ...IDENTITY.slice(1)], { width: 300, height: 100 });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("bumps the version on every change so subscribers can use it as a snapshot", () => {
    const source = createAnchorSource();
    const v0 = source.getVersion();
    source.setAnchor("a", [0, 0, 0]);
    const v1 = source.getVersion();
    expect(v1).not.toBe(v0);
    source.setAnchor("a", [0, 0, 0]);
    expect(source.getVersion()).toBe(v1);
  });

  it("stops notifying after unsubscribe", () => {
    const source = createAnchorSource();
    const listener = vi.fn();
    const stop = source.subscribe(listener);
    stop();
    source.setAnchor("a", [0, 0, 0]);
    expect(listener).not.toHaveBeenCalled();
  });
});
