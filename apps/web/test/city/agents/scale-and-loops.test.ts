import { describe, expect, it } from "vitest";
import { agentScale } from "../../../src/city/agents/scale.ts";
import { areaFor, createPose, workPose } from "../../../src/city/agents/workLoop.ts";

describe("agentScale", () => {
  it("is full size for sessions, leads and teammates", () => {
    for (const kind of ["session", "lead", "teammate", "unknown"] as const) {
      expect(agentScale(kind, 0)).toBe(1);
    }
  });

  it("shrinks each subagent generation, with a floor", () => {
    expect(agentScale("subagent", 1)).toBeCloseTo(0.6);
    expect(agentScale("subagent", 2)).toBeCloseTo(0.36);
    expect(agentScale("subagent", 9)).toBeGreaterThanOrEqual(0.3);
    expect(agentScale("subagent", 0)).toBeCloseTo(0.6);
  });
});

describe("work loops", () => {
  it("maps activity to the area loop", () => {
    expect(areaFor("implementing")).toBe("workshop");
    expect(areaFor("testing")).toBe("testLab");
    expect(areaFor("researching")).toBe("archives");
    expect(areaFor("documenting")).toBe("archives");
    expect(areaFor("idle")).toBeUndefined();
    expect(areaFor("dispatching")).toBeUndefined();
  });

  it("is periodic and bounded", () => {
    const a = createPose();
    const b = createPose();
    for (const area of ["workshop", "testLab", "archives"] as const) {
      workPose(area, 0.3, a);
      workPose(area, 0.3 + 4 * 1.2, b);
      expect(b.rightArm).toBeCloseTo(a.rightArm, 5);
      for (let t = 0; t < 5; t += 0.1) {
        workPose(area, t, a);
        expect(Math.abs(a.rightArm)).toBeLessThanOrEqual(Math.PI);
        expect(Math.abs(a.leftArm)).toBeLessThanOrEqual(Math.PI);
      }
    }
  });

  it("selects the matching prop and writes into the given pose without allocating", () => {
    const out = createPose();
    expect(workPose("workshop", 0, out)).toBe(out);
    expect(out.prop).toBe("hammer");
    workPose("testLab", 0, out);
    expect(out.prop).toBe("beaker");
    workPose("archives", 0, out);
    expect(out.prop).toBe("pages");
  });

  it("holds a rest pose with no prop when there is no area", () => {
    const out = createPose();
    workPose(undefined, 3, out);
    expect(out.prop).toBe("none");
    expect(out.rightArm).toBe(0);
    expect(out.leftArm).toBe(0);
  });
});
