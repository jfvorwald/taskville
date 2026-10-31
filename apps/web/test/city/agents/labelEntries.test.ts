import { describe, expect, it } from "vitest";
import { buildLabelEntries, LABEL_HEIGHT } from "../../../src/city/agents/labelEntries.ts";
import type { AgentView } from "../../../src/city/agents/types.ts";

function view(over: Partial<AgentView> & { id: string }): AgentView {
  return {
    kind: "session",
    activity: "testing",
    placement: { x: 1, y: 0, z: 2, heading: 0 },
    ...over,
  };
}

describe("buildLabelEntries", () => {
  it("gives each agent its text and its live placement as the anchor", () => {
    const a = view({ id: "a1", displayName: "Ada" });
    const [entry] = buildLabelEntries([a]);
    expect(entry).toMatchObject({
      id: "a1",
      name: "Ada",
      status: "Testing",
      offsetY: LABEL_HEIGHT,
    });
    expect(entry?.anchor).toBe(a.placement);
    a.placement.x = 5;
    expect(entry?.anchor.x).toBe(5);
  });

  it("lowers the label for a subagent in proportion to its size", () => {
    const [entry] = buildLabelEntries([view({ id: "s1", kind: "subagent", depth: 1 })]);
    expect(entry?.offsetY).toBeCloseTo(LABEL_HEIGHT * 0.6);
  });
});
