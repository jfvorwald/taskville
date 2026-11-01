import { describe, expect, it } from "vitest";
import type { FamilyAgent } from "../../../../src/overlays/agent-panel/shell/family.ts";
import { PANEL_TABS, visibleTabs } from "../../../../src/overlays/agent-panel/shell/tabs.ts";

// M5.05 (ARCHITECTURE.md 2.10): Live and Files for every agent; Crew only for a lead, or for an
// agent that is a parent (some other agent records it as `parentAgentId`).
//
// Contract pinned here (pure, `shell/tabs.ts`):
//   PANEL_TABS: readonly ["live", "files", "crew"]       the order the tabs are shown in
//   visibleTabs(agentId, agents): ("live" | "files" | "crew")[]   in PANEL_TABS order; [] if unknown

const agent = (
  id: string,
  over: Partial<FamilyAgent> & Pick<FamilyAgent, "kind">,
): FamilyAgent => ({
  id,
  ...over,
});

describe("PANEL_TABS", () => {
  it("is Live, Files, Crew in that order", () => {
    expect([...PANEL_TABS]).toEqual(["live", "files", "crew"]);
  });
});

describe("visibleTabs", () => {
  it("shows Crew for a lead, even before it has a teammate", () => {
    expect(visibleTabs("L", [agent("L", { kind: "lead", teamId: "T" })])).toEqual([
      "live",
      "files",
      "crew",
    ]);
  });

  it("shows Crew for a session that has a subagent, and not before", () => {
    const S = agent("S", { kind: "session" });
    const sub = agent("sub", { kind: "subagent", parentAgentId: "S" });
    expect(visibleTabs("S", [S, sub])).toEqual(["live", "files", "crew"]);
    expect(visibleTabs("S", [S])).toEqual(["live", "files"]);
  });

  it("shows Crew for a teammate or subagent that has children of its own", () => {
    const L = agent("L", { kind: "lead", teamId: "T" });
    const t = agent("t", { kind: "teammate", teamId: "T" });
    const s = agent("s", { kind: "subagent", parentAgentId: "t" });
    const leaf = agent("leaf", { kind: "subagent", parentAgentId: "s" });
    const all = [L, t, s, leaf];
    expect(visibleTabs("t", all)).toEqual(["live", "files", "crew"]);
    expect(visibleTabs("s", all)).toEqual(["live", "files", "crew"]);
  });

  it("hides Crew for a leaf: a childless teammate, subagent, session or unknown agent", () => {
    const L = agent("L", { kind: "lead", teamId: "T" });
    const t = agent("t", { kind: "teammate", teamId: "T" });
    const s = agent("s", { kind: "subagent", parentAgentId: "S" });
    const S = agent("S", { kind: "session" });
    const u = agent("u", { kind: "unknown" });
    const all = [L, t, s, S, u];
    for (const id of ["t", "s", "u"]) expect(visibleTabs(id, all)).toEqual(["live", "files"]);
  });

  it("does not count a teammate as a child of another teammate", () => {
    const a = agent("a", { kind: "teammate", teamId: "T" });
    const b = agent("b", { kind: "teammate", teamId: "T" });
    expect(visibleTabs("a", [a, b])).toEqual(["live", "files"]);
  });

  it("is empty for an agent that is not known", () => {
    expect(visibleTabs("ghost", [])).toEqual([]);
  });
});
