import { describe, expect, it } from "vitest";
import { easeCameraTo, highlightState } from "./highlightState.ts";

// M5.08 (ARCHITECTURE.md 2.10 "Crew tab", issue #66): the city-side family highlight, as pure
// functions. Plain-data in, plain-data out; no React, no three.js. (These pure tests are named
// *.browser.test.tsx only because the node vitest project includes test/**; they need no DOM.)
//
// Intended interface, in ./highlightState.ts (new file):
//   highlightState({ openAgentId, hoveredId?, agents, teams? }): HighlightState
//     openAgentId  the agent whose Crew tab is open, or null when no Crew tab is open
//     hoveredId    the crew row under the pointer, or null/undefined
//     agents       Record<string, FamilyAgent> (the store's state.agents; see shell/family.ts)
//     teams        optional FamilyTeams, passed through to the family rules
//   HighlightState = {
//     active: boolean;            // false unless a Crew tab is open for a known agent with children
//     parentId: string | null;    // the open agent; the outline uses ITS trim color
//     childIds: string[];         // direct children, by registeredSeq then id
//     familyIds: string[];        // [parentId, ...childIds]
//     dimmedIds: string[];        // every other agent, sorted by id; empty when inactive
//     tethers: { from: string; to: string }[]; // dotted lines, parent -> each child, child order
//     bounceId: string | null;    // hovered family member to bounce once, else null
//   }
//   easeCameraTo(view: {x, z, zoom}, target: {x, z}): {x, z, zoom}
//     the camera target moves to the agent; zoom is returned unchanged (never zoomed on click).
//
// Children are the recorded links only (constitution IV): subagents by parentAgentId, teammates
// of a lead by team. A grandchild is not in its grandparent's family.

const mk = (id: string, over: Record<string, unknown>) => ({
  id,
  registeredSeq: undefined,
  ...over,
});
const agents = {
  L: mk("L", { kind: "lead", teamId: "T", registeredSeq: 1 }),
  t2: mk("t2", { kind: "teammate", teamId: "T", registeredSeq: 2 }),
  t1: mk("t1", { kind: "teammate", teamId: "T", registeredSeq: 3 }),
  s1: mk("s1", { kind: "subagent", parentAgentId: "t1", registeredSeq: 4 }),
  S: mk("S", { kind: "session", registeredSeq: 5 }),
} as never;

describe("highlightState", () => {
  it("is inactive and dims nothing while no Crew tab is open", () => {
    const s = highlightState({ openAgentId: null, agents });
    expect(s).toEqual({
      active: false,
      parentId: null,
      childIds: [],
      familyIds: [],
      dimmedIds: [],
      tethers: [],
      bounceId: null,
    });
  });

  it("is inactive for an unknown agent and for an agent with no children", () => {
    expect(highlightState({ openAgentId: "nope", agents }).active).toBe(false);
    expect(highlightState({ openAgentId: "S", agents }).active).toBe(false);
    expect(highlightState({ openAgentId: "S", agents }).dimmedIds).toEqual([]);
  });

  it("highlights the parent and its direct children, dimming everyone else", () => {
    const s = highlightState({ openAgentId: "t1", agents });
    expect(s.active).toBe(true);
    expect(s.parentId).toBe("t1");
    expect(s.childIds).toEqual(["s1"]);
    expect(s.familyIds).toEqual(["t1", "s1"]);
    expect(s.dimmedIds).toEqual(["L", "S", "t2"]);
    expect(s.tethers).toEqual([{ from: "t1", to: "s1" }]);
  });

  it("orders a lead's teammates by registration, with one tether each", () => {
    const s = highlightState({ openAgentId: "L", agents });
    expect(s.childIds).toEqual(["t2", "t1"]);
    expect(s.familyIds).toEqual(["L", "t2", "t1"]);
    expect(s.dimmedIds).toEqual(["S", "s1"]);
    expect(s.tethers).toEqual([
      { from: "L", to: "t2" },
      { from: "L", to: "t1" },
    ]);
  });

  it("bounces only a hovered family member", () => {
    expect(highlightState({ openAgentId: "L", hoveredId: "t1", agents }).bounceId).toBe("t1");
    expect(highlightState({ openAgentId: "L", hoveredId: "S", agents }).bounceId).toBeNull();
    expect(highlightState({ openAgentId: "L", hoveredId: null, agents }).bounceId).toBeNull();
    expect(highlightState({ openAgentId: null, hoveredId: "t1", agents }).bounceId).toBeNull();
  });

  it("honors a recorded team lead over the first registered lead", () => {
    const two = {
      ...(agents as object),
      L2: mk("L2", { kind: "lead", teamId: "T", registeredSeq: 9 }),
    } as never;
    const s = highlightState({
      openAgentId: "L2",
      agents: two,
      teams: { T: { leadAgentId: "L2" } },
    });
    expect(s.childIds).toEqual(["t2", "t1"]);
  });
});

describe("easeCameraTo", () => {
  it("moves the camera target and never changes zoom", () => {
    expect(easeCameraTo({ x: 0, z: 0, zoom: 37 }, { x: 4, z: -2 })).toEqual({
      x: 4,
      z: -2,
      zoom: 37,
    });
  });
});
