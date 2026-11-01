import { describe, expect, it } from "vitest";
import { subagentScale } from "../../../../src/city/crew/subagents/generation.ts";
import {
  doorRadius,
  markerSpot,
  reachOf,
  workSpot,
} from "../../../../src/city/crew/subagents/spots.ts";

// Where a family stands around its parent (ARCHITECTURE 2.9: the bots stand in front of the
// parent, a "+N crew" marker stands by them). In the parent's frame, +z is the front.

interface Point {
  x: number;
  z: number;
}

const at = (angle: number, radius: number): Point => ({
  x: Math.sin(angle) * radius,
  z: Math.cos(angle) * radius,
});
const gap = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);

describe("workSpot (the arc)", () => {
  it("puts the middle slot straight ahead of the parent and the others either side of it", () => {
    expect(workSpot(3, 1).angle).toBe(0);
    for (const k of [1, 2, 3]) {
      expect(workSpot(3 - k, 1).angle).toBeCloseTo(-workSpot(3 + k, 1).angle, 10);
      expect(workSpot(3 - k, 1).angle).toBeLessThan(0);
    }
  });

  it("gives the first seven bots distinct places on one arc, in order from one side to the other", () => {
    const spots = Array.from({ length: 7 }, (_, i) => workSpot(i, 1));
    expect(new Set(spots.map((s) => s.radius)).size).toBe(1);
    for (let i = 1; i < spots.length; i++) {
      expect(spots[i]?.angle).toBeGreaterThan(spots[i - 1]?.angle as number);
    }
  });

  it("keeps every bot of the first two rows apart from the others", () => {
    const places = Array.from({ length: 14 }, (_, i) => {
      const s = workSpot(i, 1);
      return at(s.angle, s.radius);
    });
    for (let i = 0; i < places.length; i++) {
      for (let j = i + 1; j < places.length; j++) {
        expect(gap(places[i] as Point, places[j] as Point), `${i} and ${j}`).toBeGreaterThan(0.5);
      }
    }
  });

  it("starts a second row behind the first when the arc is full, on the same angles", () => {
    expect(workSpot(7, 1).angle).toBe(workSpot(0, 1).angle);
    expect(workSpot(13, 1).angle).toBe(workSpot(6, 1).angle);
    expect(workSpot(7, 1).radius).toBeGreaterThan(workSpot(0, 1).radius);
    expect(workSpot(14, 1).radius).toBeGreaterThan(workSpot(7, 1).radius);
  });

  it("scales every distance with the reach of the parent", () => {
    for (const i of [0, 3, 7]) {
      expect(workSpot(i, 0.5).radius).toBeCloseTo(workSpot(i, 1).radius * 0.5, 10);
      expect(workSpot(i, 0.5).angle).toBe(workSpot(i, 1).angle);
    }
  });
});

describe("markerSpot", () => {
  it("stands clear of the three bots a parent shows beside it", () => {
    const marker = markerSpot(1);
    for (let i = 0; i < 3; i++) {
      const s = workSpot(i, 1);
      expect(
        gap(at(marker.angle, marker.radius), at(s.angle, s.radius)),
        `bot ${i}`,
      ).toBeGreaterThan(0.5);
    }
  });

  it("scales with the reach of the parent", () => {
    expect(markerSpot(0.5).radius).toBeCloseTo(markerSpot(1).radius * 0.5, 10);
    expect(markerSpot(0.5).angle).toBe(markerSpot(1).angle);
  });
});

describe("reachOf", () => {
  it("is full for a parent that is not a subagent", () => {
    expect(reachOf(0)).toBe(1);
  });

  it("is the size of a subagent of that generation, so smaller parents keep their crew close", () => {
    expect(reachOf(1)).toBe(subagentScale(1));
    expect(reachOf(2)).toBe(subagentScale(2));
    expect(reachOf(1)).toBeLessThan(1);
    expect(reachOf(2)).toBeLessThan(reachOf(1));
    expect(reachOf(2)).toBeGreaterThan(0);
  });
});

describe("doorRadius", () => {
  it("is inside the first row of bots, so a bot walks out from the door to its spot", () => {
    expect(doorRadius(1)).toBeGreaterThan(0);
    expect(doorRadius(1)).toBeLessThan(workSpot(0, 1).radius);
  });

  it("scales with the reach of the parent", () => {
    expect(doorRadius(0.5)).toBeCloseTo(doorRadius(1) * 0.5, 10);
    expect(doorRadius(reachOf(1))).toBeLessThan(workSpot(0, reachOf(1)).radius);
  });
});
