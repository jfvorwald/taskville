import { describe, expect, it } from "vitest";
import { type AnchoredBox, layoutAnchored } from "../../../src/overlays/host/collision.ts";

const BOUNDS = { width: 800, height: 600 };

function box(id: string, x: number, y: number, over: Partial<AnchoredBox> = {}): AnchoredBox {
  return { id, x, y, width: 100, height: 20, priority: 0, visible: true, ...over };
}

function byId(result: ReturnType<typeof layoutAnchored>) {
  return new Map(result.map((r) => [r.id, r]));
}

function overlap(
  a: { left: number; top: number },
  b: { left: number; top: number },
  w = 100,
  h = 20,
) {
  return a.left < b.left + w && b.left < a.left + w && a.top < b.top + h && b.top < a.top + h;
}

describe("layoutAnchored", () => {
  it("centres a box above its anchor point when nothing collides", () => {
    const [r] = layoutAnchored([box("a", 400, 300)], BOUNDS);
    expect(r).toEqual({ id: "a", left: 350, top: 280, visible: true });
  });

  it("leaves boxes alone when they do not overlap", () => {
    const r = byId(layoutAnchored([box("a", 200, 300), box("b", 500, 300)], BOUNDS));
    expect(r.get("a")).toMatchObject({ left: 150, top: 280 });
    expect(r.get("b")).toMatchObject({ left: 450, top: 280 });
  });

  it("keeps the higher priority box in place and lifts the lower one clear", () => {
    const r = byId(
      layoutAnchored(
        [box("low", 400, 300, { priority: 1 }), box("high", 410, 300, { priority: 5 })],
        BOUNDS,
      ),
    );
    expect(r.get("high")).toMatchObject({ top: 280, visible: true });
    const low = r.get("low");
    expect(low?.visible).toBe(true);
    expect(
      low && r.get("high") && overlap(low, r.get("high") as { left: number; top: number }),
    ).toBe(false);
    expect(low?.top).toBeLessThan(280);
  });

  it("separates a pile of boxes on one anchor without any overlap", () => {
    const boxes = ["a", "b", "c", "d"].map((id, i) => box(id, 400, 300, { priority: 10 - i }));
    const placed = layoutAnchored(boxes, BOUNDS).filter((r) => r.visible);
    expect(placed).toHaveLength(4);
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++)
        expect(overlap(placed[i] as never, placed[j] as never)).toBe(false);
  });

  it("is deterministic whatever the input order, breaking priority ties by id", () => {
    const boxes = [box("b", 400, 300), box("a", 400, 300), box("c", 400, 300)];
    const forward = layoutAnchored(boxes, BOUNDS);
    const backward = layoutAnchored([...boxes].reverse(), BOUNDS);
    expect(byId(forward)).toEqual(byId(backward));
    expect(byId(forward).get("a")?.top).toBe(280);
  });

  it("returns one result per input, in input order", () => {
    const r = layoutAnchored([box("z", 100, 300), box("a", 500, 300)], BOUNDS);
    expect(r.map((x) => x.id)).toEqual(["z", "a"]);
  });

  it("hides a box that cannot be lifted clear without leaving the top of the bounds", () => {
    const boxes = [box("a", 400, 25, { priority: 2 }), box("b", 400, 25, { priority: 1 })];
    const r = byId(layoutAnchored(boxes, BOUNDS));
    expect(r.get("a")).toMatchObject({ visible: true, top: 5 });
    expect(r.get("b")?.visible).toBe(false);
  });

  it("passes invisible boxes through hidden and does not let them take space", () => {
    const r = byId(
      layoutAnchored(
        [box("ghost", 400, 300, { visible: false, priority: 9 }), box("a", 400, 300)],
        BOUNDS,
      ),
    );
    expect(r.get("ghost")?.visible).toBe(false);
    expect(r.get("a")).toMatchObject({ top: 280, visible: true });
  });

  it("clamps a box horizontally into the bounds", () => {
    const r = byId(layoutAnchored([box("l", 10, 300), box("r", 795, 300)], BOUNDS));
    expect(r.get("l")?.left).toBe(0);
    expect(r.get("r")?.left).toBe(700);
  });

  it("honours a gap between boxes", () => {
    const boxes = [box("a", 400, 300, { priority: 2 }), box("b", 400, 300, { priority: 1 })];
    const r = byId(layoutAnchored(boxes, BOUNDS, { gap: 6 }));
    expect(r.get("a")?.top).toBe(280);
    expect(r.get("b")?.top).toBe(254);
  });

  // The anchor is on screen (or within the layer's margin), so its label must show, clamped
  // into the bounds, rather than being hidden because the box would poke out of the edge.
  it("shows a label whose anchor is within one label height of the top edge, clamped to 0", () => {
    const [r] = layoutAnchored([box("a", 400, 10)], BOUNDS);
    expect(r).toEqual({ id: "a", left: 350, top: 0, visible: true });
  });

  it("shows a label whose anchor is exactly on the top edge", () => {
    const [r] = layoutAnchored([box("a", 400, 0)], BOUNDS);
    expect(r).toMatchObject({ top: 0, visible: true });
  });

  it("shows a label whose anchor is slightly above the top edge, within the margin", () => {
    const [r] = layoutAnchored([box("a", 400, -30)], BOUNDS);
    expect(r).toMatchObject({ top: 0, visible: true });
  });

  it("shows a label whose anchor is just below the bottom edge, clamped to the bottom", () => {
    const [r] = layoutAnchored([box("a", 400, 620)], BOUNDS);
    expect(r).toEqual({ id: "a", left: 350, top: 580, visible: true });
  });

  it("shows labels for anchors 1 and 48 px below the bottom edge", () => {
    const r = byId(layoutAnchored([box("near", 200, 601), box("far", 600, 648)], BOUNDS));
    expect(r.get("near")).toMatchObject({ top: 580, visible: true });
    expect(r.get("far")).toMatchObject({ top: 580, visible: true });
  });

  it("still hides a clamped label that collides and cannot be lifted clear", () => {
    const boxes = [box("a", 400, 10, { priority: 2 }), box("b", 400, 10, { priority: 1 })];
    const r = byId(layoutAnchored(boxes, BOUNDS));
    expect(r.get("a")).toMatchObject({ top: 0, visible: true });
    expect(r.get("b")?.visible).toBe(false);
  });

  it("hides boxes larger than the bounds rather than looping", () => {
    const r = layoutAnchored([box("huge", 400, 300, { width: 2000, height: 2000 })], BOUNDS);
    expect(r[0]?.visible).toBe(false);
  });
});
