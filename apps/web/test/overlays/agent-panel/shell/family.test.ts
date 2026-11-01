import { describe, expect, it } from "vitest";
import {
  type FamilyAgent,
  familyOrder,
  familyPath,
  stepFamily,
} from "../../../../src/overlays/agent-panel/shell/family.ts";

// M5.05 (ARCHITECTURE.md 2.10): the family the panel header and the [ and ] keys walk.
//
// Contract pinned here (pure, `shell/family.ts`):
//   familyPath(agentId, agents): string[]        root to agent, ids; [] for an unknown id
//   familyOrder(agentId, agents): string[]       every member of the agent's family, ids
//   stepFamily(agentId, agents, 1 | -1): string | null
//
// Parent links come only from the recorded fields (constitution IV), never from names:
//   - a subagent's parent is `parentAgentId`;
//   - a teammate's parent is the `lead` agent with the same `teamId`;
//   - anything else (session, lead, unknown, or a parent that is not in `agents`) is a root.
// The family is the tree under the agent's root. `familyOrder` is that tree depth first, parent
// before children, siblings by `registeredSeq` ascending (an agent with none after those that
// have one, then by id). The same order from every member, whatever order `agents` arrives in.
// `stepFamily` WRAPS: stepping forward from the last member gives the first, and backward from
// the first gives the last. It is null when the family is only the agent itself, or unknown.

const agent = (
  id: string,
  over: Partial<FamilyAgent> & Pick<FamilyAgent, "kind">,
): FamilyAgent => ({
  id,
  ...over,
});

// Team T: lead L; teammates t2 (registered 2) and t1 (registered 3); t1 spawned subagent s1.
// Registration order is deliberately not alphabetical and not the array order.
const L = agent("L", { kind: "lead", teamId: "T", registeredSeq: 1 });
const t1 = agent("t1", { kind: "teammate", teamId: "T", registeredSeq: 3 });
const t2 = agent("t2", { kind: "teammate", teamId: "T", registeredSeq: 2 });
const s1 = agent("s1", { kind: "subagent", parentAgentId: "t1", registeredSeq: 4 });
// A solo session with one subagent, and another team that must not leak into T.
const S = agent("S", { kind: "session", registeredSeq: 5 });
const sub = agent("sub", { kind: "subagent", parentAgentId: "S", registeredSeq: 6 });
const L2 = agent("L2", { kind: "lead", teamId: "T2", registeredSeq: 7 });
const m2 = agent("m2", { kind: "teammate", teamId: "T2", registeredSeq: 8 });

const world = [s1, t1, S, m2, t2, sub, L2, L];

describe("familyPath", () => {
  it("runs from the root to the agent", () => {
    expect(familyPath("s1", world)).toEqual(["L", "t1", "s1"]);
    expect(familyPath("sub", world)).toEqual(["S", "sub"]);
  });

  it("links a teammate to the lead of its own team only", () => {
    expect(familyPath("t2", world)).toEqual(["L", "t2"]);
    expect(familyPath("m2", world)).toEqual(["L2", "m2"]);
  });

  it("is just the agent for a root", () => {
    expect(familyPath("L", world)).toEqual(["L"]);
    expect(familyPath("S", world)).toEqual(["S"]);
  });

  it("is empty for an agent that is not known", () => {
    expect(familyPath("ghost", world)).toEqual([]);
    expect(familyPath("L", [])).toEqual([]);
  });

  it("stops at the last known agent when a parent is missing (no invented crumb)", () => {
    const orphan = agent("o", { kind: "subagent", parentAgentId: "gone" });
    expect(familyPath("o", [orphan])).toEqual(["o"]);
    const loneMate = agent("m", { kind: "teammate", teamId: "NoLead" });
    expect(familyPath("m", [loneMate])).toEqual(["m"]);
  });

  it("terminates on a parent cycle and lists no agent twice", () => {
    const a = agent("a", { kind: "subagent", parentAgentId: "b" });
    const b = agent("b", { kind: "subagent", parentAgentId: "a" });
    const path = familyPath("a", [a, b]);
    expect(path[path.length - 1]).toBe("a");
    expect(new Set(path).size).toBe(path.length);
  });
});

describe("familyOrder", () => {
  it("is the whole tree, depth first, siblings by registration order", () => {
    expect(familyOrder("L", world)).toEqual(["L", "t2", "t1", "s1"]);
  });

  it("is the same list from every member", () => {
    for (const id of ["L", "t1", "t2", "s1"]) {
      expect(familyOrder(id, world)).toEqual(["L", "t2", "t1", "s1"]);
    }
  });

  it("does not depend on the order agents arrive in", () => {
    expect(familyOrder("t1", [...world].reverse())).toEqual(["L", "t2", "t1", "s1"]);
  });

  it("keeps other families out", () => {
    expect(familyOrder("sub", world)).toEqual(["S", "sub"]);
    expect(familyOrder("m2", world)).toEqual(["L2", "m2"]);
  });

  it("puts siblings with no registration after registered ones, then by id", () => {
    const root = agent("r", { kind: "session", registeredSeq: 1 });
    const kids = [
      agent("z", { kind: "subagent", parentAgentId: "r" }),
      agent("b", { kind: "subagent", parentAgentId: "r" }),
      agent("late", { kind: "subagent", parentAgentId: "r", registeredSeq: 9 }),
      agent("early", { kind: "subagent", parentAgentId: "r", registeredSeq: 2 }),
    ];
    expect(familyOrder("r", [...kids, root])).toEqual(["r", "early", "late", "b", "z"]);
  });

  it("is the agent alone when it has no family, and empty when unknown", () => {
    expect(familyOrder("S", [S])).toEqual(["S"]);
    expect(familyOrder("ghost", world)).toEqual([]);
  });
});

describe("stepFamily", () => {
  it("steps forward and backward through familyOrder", () => {
    expect(stepFamily("L", world, 1)).toBe("t2");
    expect(stepFamily("t2", world, 1)).toBe("t1");
    expect(stepFamily("t1", world, 1)).toBe("s1");
    expect(stepFamily("s1", world, -1)).toBe("t1");
    expect(stepFamily("t2", world, -1)).toBe("L");
  });

  it("wraps at both ends", () => {
    expect(stepFamily("s1", world, 1)).toBe("L");
    expect(stepFamily("L", world, -1)).toBe("s1");
  });

  it("is null when there is nowhere to go", () => {
    expect(stepFamily("S", [S], 1)).toBeNull();
    expect(stepFamily("S", [S], -1)).toBeNull();
    expect(stepFamily("ghost", world, 1)).toBeNull();
  });
});
