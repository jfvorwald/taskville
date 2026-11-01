import { describe, expect, it } from "vitest";
import { agentColors } from "../../../../src/city/agents/identity.ts";
import type { AgentView } from "../../../../src/city/agents/types.ts";
import { teamScarfColor } from "../../../../src/city/crew/teams/color.ts";

// ARCHITECTURE 2.9: a teammate is a full-size bot with the team's shared scarf color. The color is
// a pure function of the team id, so it is the same on every call, in every session, for the lead
// and for every teammate, and it never depends on who has joined or what anyone is doing.

const HEX = /^#[0-9a-f]{6}$/;
const THEMES = ["cyberpunk", "steampunk", "solarpunk", "aero"] as const;

function view(over: Partial<AgentView> & { id: string }): AgentView {
  return {
    kind: "teammate",
    activity: "idle",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
    ...over,
  };
}

describe("teamScarfColor", () => {
  it("returns a well-formed hex color", () => {
    expect(teamScarfColor("claude-code:team:session-b4395a96")).toMatch(HEX);
  });

  it("is stable across calls for one team", () => {
    const id = "claude-code:team:session-b4395a96";
    const first = teamScarfColor(id);
    for (let i = 0; i < 5; i++) expect(teamScarfColor(id)).toBe(first);
  });

  it("separates distinct teams", () => {
    const colors = new Set<string>();
    for (let i = 0; i < 24; i++) colors.add(teamScarfColor(`claude-code:team:session-${i}`));
    expect(colors.size).toBeGreaterThanOrEqual(20);
  });

  it("is the scarf the block-agent layer already draws, for teammates and the lead alike", () => {
    const teamId = "claude-code:team:session-b4395a96";
    const mate = view({ id: "m1", kind: "teammate", teamId, displayName: "pip" });
    const lead = view({ id: "l1", kind: "lead", teamId });
    expect(agentColors(mate).trim).toBe(teamScarfColor(teamId));
    expect(agentColors(lead).trim).toBe(teamScarfColor(teamId));
  });

  it("does not depend on the teammate's name or id", () => {
    const teamId = "t1";
    const a = teamScarfColor(teamId);
    expect(agentColors(view({ id: "x", teamId, displayName: "pip" })).trim).toBe(a);
    expect(agentColors(view({ id: "y", teamId, displayName: "bo" })).trim).toBe(a);
  });

  describe("with a theme", () => {
    it.each(THEMES)("is a stable hex color in %s", (theme) => {
      const id = "claude-code:team:session-b4395a96";
      const first = teamScarfColor(id, theme);
      expect(first).toMatch(HEX);
      expect(teamScarfColor(id, theme)).toBe(first);
    });

    it.each(THEMES)("still separates distinct teams in %s", (theme) => {
      const colors = new Set<string>();
      for (let i = 0; i < 24; i++) colors.add(teamScarfColor(`team-${i}`, theme));
      expect(colors.size).toBeGreaterThanOrEqual(20);
    });
  });
});
