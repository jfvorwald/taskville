import { describe, expect, it } from "vitest";
import { createRig } from "../../../src/city/effects/Celebrations.tsx";
import { agentAnchorId } from "../../../src/city/movement/index.ts";
import { createAnchorSource } from "../../../src/overlays/host/index.ts";
import { gitMerge, handoff, taskCompleted, testGreen } from "./events.ts";

// Review finding 1, rig level: `createRig(anchors).play(celebration, event, nowMs)` returns true
// when the celebration was drawn and false when it could not be (an agent without an anchor).
// Merge burst and shimmer need no agent, so they always return true.

function setup(placed: readonly string[] = []) {
  const anchors = createAnchorSource();
  for (const id of placed) anchors.setAnchor(agentAnchorId(id), [1, 0, 2]);
  const rig = createRig(anchors);
  return { rig, anchors };
}

describe("createRig(...).play reports whether it drew", () => {
  it("confetti: false when the agent is not placed, true when it is", () => {
    const { rig } = setup(["a1"]);
    const confetti = (agentId: string) =>
      ({ kind: "confetti", agentId, particles: 40, durationMs: 1200 }) as const;
    expect(rig.play(confetti("ghost"), taskCompleted("ghost"), 1000)).toBe(false);
    expect(rig.play(confetti("a1"), taskCompleted("a1"), 1000)).toBe(true);
    rig.dispose();
  });

  it("high-five: false when either agent is not placed, true when both are", () => {
    const { rig } = setup(["a1", "a2"]);
    const hf = (fromAgentId: string, toAgentId: string) =>
      ({ kind: "high-five", fromAgentId, toAgentId }) as const;
    expect(rig.play(hf("a1", "ghost"), handoff("a1", "ghost"), 1000)).toBe(false);
    expect(rig.play(hf("ghost", "a2"), handoff("ghost", "a2"), 1000)).toBe(false);
    expect(rig.play(hf("a1", "a2"), handoff("a1", "a2"), 1000)).toBe(true);
    rig.dispose();
  });

  it("merge burst and shimmer always draw", () => {
    const { rig } = setup();
    expect(rig.play({ kind: "merge-burst", area: "archives" }, gitMerge(), 1000)).toBe(true);
    expect(rig.play({ kind: "shimmer", area: "test-lab" }, testGreen("a1"), 1000)).toBe(true);
    rig.dispose();
  });

  it("reduced-motion sparkle over an agent: false when not placed, true when placed", () => {
    const { rig } = setup(["a1"]);
    const sparkle = (agentId: string) =>
      ({ kind: "sparkle", source: "confetti", agentId }) as const;
    expect(rig.play(sparkle("ghost"), taskCompleted("ghost"), 1000)).toBe(false);
    expect(rig.play(sparkle("a1"), taskCompleted("a1"), 1000)).toBe(true);
    rig.dispose();
  });

  it("reduced-motion sparkle for a handoff: false when an agent is not placed, true when both are", () => {
    const { rig } = setup(["a1", "a2"]);
    const sparkle = { kind: "sparkle", source: "high-five" } as const;
    expect(rig.play(sparkle, handoff("a1", "ghost"), 1000)).toBe(false);
    expect(rig.play(sparkle, handoff("a1", "a2"), 1000)).toBe(true);
    rig.dispose();
  });

  it("reduced-motion sparkle for a merge or a shimmer always draws", () => {
    const { rig } = setup();
    expect(rig.play({ kind: "sparkle", source: "merge-burst" }, gitMerge(), 1000)).toBe(true);
    expect(rig.play({ kind: "sparkle", source: "shimmer" }, testGreen("a1"), 1000)).toBe(true);
    rig.dispose();
  });

  it("an undrawn celebration leaves nothing in the played history", () => {
    const { rig } = setup();
    rig.play(
      { kind: "confetti", agentId: "ghost", particles: 40, durationMs: 1200 },
      taskCompleted("ghost"),
      1000,
    );
    expect(rig.history.entries()).toHaveLength(0);
    rig.dispose();
  });
});
