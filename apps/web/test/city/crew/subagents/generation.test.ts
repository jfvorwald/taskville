import { describe, expect, it } from "vitest";
import { agentScale } from "../../../../src/city/agents/scale.ts";
import {
  MAX_BOT_GENERATION,
  splitByGeneration,
  subagentScale,
} from "../../../../src/city/crew/subagents/generation.ts";

describe("subagentScale", () => {
  it("makes generation 1 smaller than its full-size parent", () => {
    expect(subagentScale(1)).toBeLessThan(1);
    expect(subagentScale(1)).toBeGreaterThan(0);
  });

  it("shrinks every further generation", () => {
    let previous = 1;
    for (let generation = 1; generation <= MAX_BOT_GENERATION; generation++) {
      const scale = subagentScale(generation);
      expect(scale).toBeLessThan(previous);
      previous = scale;
    }
  });

  it("agrees with the block agents' size for a subagent, so the crew and the city match", () => {
    for (let generation = 1; generation <= MAX_BOT_GENERATION; generation++) {
      expect(subagentScale(generation)).toBeCloseTo(agentScale("subagent", generation));
    }
  });

  it("treats a generation below 1 as the first generation", () => {
    expect(subagentScale(0)).toBe(subagentScale(1));
    expect(subagentScale(-3)).toBe(subagentScale(1));
  });
});

describe("splitByGeneration", () => {
  it("draws two levels of subagents as bots", () => {
    expect(MAX_BOT_GENERATION).toBe(2);
    const split = splitByGeneration([
      { id: "a", generation: 1 },
      { id: "b", generation: 2 },
    ]);
    expect(split.bots.map((s) => s.id)).toEqual(["a", "b"]);
    expect(split.deepCount).toBe(0);
  });

  it("shows everything below two levels as a count on the parent, not as bots", () => {
    const split = splitByGeneration([
      { id: "a", generation: 1 },
      { id: "b", generation: 3 },
      { id: "c", generation: 4 },
      { id: "d", generation: 3 },
    ]);
    expect(split.bots.map((s) => s.id)).toEqual(["a"]);
    expect(split.deepCount).toBe(3);
  });

  it("keeps input order and handles an empty crew", () => {
    expect(splitByGeneration([])).toEqual({ bots: [], deepCount: 0 });
    const split = splitByGeneration([
      { id: "z", generation: 2 },
      { id: "y", generation: 1 },
    ]);
    expect(split.bots.map((s) => s.id)).toEqual(["z", "y"]);
  });
});
