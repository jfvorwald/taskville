import { describe, expect, it } from "vitest";
import type { AgentView } from "../../../../src/city/agents/types.ts";
import { teamAccessories } from "../../../../src/city/crew/teams/accessories.ts";
import { teamScarfColor } from "../../../../src/city/crew/teams/color.ts";

// The block-agent layer (CityAgents / buildModels) already draws teammates and leads as full-size
// bots. This layer only adds what is team-specific: the shared scarf color, the name tag, and the
// lead's hard hat at Dispatch. It returns one accessory record per existing agent and carries no
// body of its own, so nothing is drawn twice (M5.02 hit that bug with subagents).

const TEAM = "claude-code:team:session-b4395a96";

function view(over: Partial<AgentView> & { id: string }): AgentView {
  return {
    kind: "session",
    activity: "idle",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
    ...over,
  };
}

const lead = view({ id: "lead", kind: "lead", teamId: TEAM, displayName: "team-lead" });
const pip = view({ id: "pip", kind: "teammate", teamId: TEAM, displayName: "pip" });
const bo = view({ id: "bo", kind: "teammate", teamId: TEAM, displayName: "bo" });

describe("teamAccessories", () => {
  it("gives every teammate and the lead the team's scarf color", () => {
    const out = teamAccessories([lead, pip, bo]);
    expect(out.map((a) => a.agentId)).toEqual(["lead", "pip", "bo"]);
    for (const a of out) expect(a.scarf).toBe(teamScarfColor(TEAM));
  });

  it("names a teammate by its recorded name", () => {
    expect(teamAccessories([pip])[0]?.nameTag).toBe("pip");
  });

  it("does not invent a name tag for a teammate with no recorded name", () => {
    const nameless = view({ id: "m9", kind: "teammate", teamId: TEAM });
    const [a] = teamAccessories([nameless]);
    expect(a?.agentId).toBe("m9");
    expect(a?.nameTag).toBeUndefined();
  });

  it("puts a hard hat on the lead, standing at Dispatch, and on nobody else", () => {
    const [l, p] = teamAccessories([lead, pip]);
    expect(l).toMatchObject({ agentId: "lead", hardHat: true, home: "dispatch" });
    expect(p).toMatchObject({ agentId: "pip", hardHat: false });
    expect(p?.home).toBeUndefined();
  });

  it("adds nothing for sessions, subagents, unknown agents, or a teammate with no team", () => {
    const out = teamAccessories([
      view({ id: "s1", kind: "session" }),
      view({ id: "s2", kind: "subagent", depth: 1 }),
      view({ id: "u1", kind: "unknown", teamId: TEAM }),
      view({ id: "m0", kind: "teammate", displayName: "ghost" }),
      pip,
    ]);
    expect(out.map((a) => a.agentId)).toEqual(["pip"]);
  });

  it("keeps different teams' scarves apart", () => {
    const other = view({
      id: "zed",
      kind: "teammate",
      teamId: "claude-code:team:session-0d2f9c11",
    });
    const out = teamAccessories([pip, other]);
    expect(out[0]?.scarf).not.toBe(out[1]?.scarf);
  });

  it("returns at most one record per agent id, only for ids it was given, and no body", () => {
    const out = teamAccessories([lead, pip, bo, pip]);
    const ids = out.map((a) => a.agentId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(["lead", "pip", "bo"]).toContain(id);
    for (const a of out) {
      expect(a).not.toHaveProperty("body");
      expect(a).not.toHaveProperty("placement");
    }
  });

  it("is a pure read of its input", () => {
    const input = [lead, pip];
    const before = JSON.stringify(input);
    expect(teamAccessories(input)).toEqual(teamAccessories(input));
    expect(JSON.stringify(input)).toBe(before);
  });
});
