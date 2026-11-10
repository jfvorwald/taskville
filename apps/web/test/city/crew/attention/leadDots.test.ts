import { describe, expect, it } from "vitest";
import {
  type AttributionAgent,
  type CrewAttributionInput,
  crewAttribution,
  leadDotTargets,
} from "../../../../src/city/crew/attention/attribution.ts";
import { agentBySource, agentNamed, recordsOf, replay } from "./replay.ts";

// M5.10 red round 2 (roborev job 6596 on PR #328): the lead's red dot must stand for every red
// agent that reaches the lead THROUGH A TEAMMATE, including that teammate's subagents. Red agents
// directly under the lead are dotted by SubagentCrew already, so the helper drops them (no second
// dot). Interface: leadDotTargets(out, agents, leadId) -> sorted red ids, read from out.dots[leadId].

const PIP = "apip-5cb5e9bb3f2f1097";

describe("leadDotTargets on the S-2 in-process team", () => {
  // pip's Bash prompt (fixture seq 31), opened as the M4 bridge would.
  const stuck = replay("team/in-process", {
    upTo: 31,
    bridge: (hook, state) =>
      hook.seq === 31 ? { agent: agentBySource(state, PIP), tool: "Bash" } : undefined,
  });
  const lead = agentNamed(stuck.state, "lead", "owner");
  const pip = agentNamed(stuck.state, "teammate", "pip");

  it("keeps a stuck teammate", () => {
    const out = crewAttribution({
      agents: stuck.state.agents,
      teams: stuck.state.teams,
      attention: recordsOf(stuck),
    });
    expect(leadDotTargets(out, stuck.state.agents, lead.id)).toEqual([pip.id]);
  });

  it("keeps a stuck subagent of that real teammate and still counts the teammate", () => {
    // The fixtures record no subagent under a teammate, so one is added by hand on real state.
    const sub: AttributionAgent = { id: "sub-of-pip", kind: "subagent", parentAgentId: pip.id };
    const agents = { ...stuck.state.agents, [sub.id]: sub };
    const out = crewAttribution({
      agents,
      teams: stuck.state.teams,
      attention: [
        ...recordsOf(stuck),
        {
          agentId: sub.id,
          level: "needs_you",
          kind: "permission",
          since: "2026-10-30T12:03:00.000Z",
          heuristic: false,
        },
      ],
    });
    expect(leadDotTargets(out, agents, lead.id)).toEqual([pip.id, sub.id].sort());
  });
});

describe("leadDotTargets on hand-built families", () => {
  const agent = (id: string, kind: string, extra: Partial<AttributionAgent> = {}) => ({
    id,
    kind,
    ...extra,
  });
  const stuck = (agentId: string) => ({
    agentId,
    level: "needs_you" as const,
    kind: "permission" as const,
    since: "2026-10-30T12:00:00.000Z",
    heuristic: false,
  });
  const family: CrewAttributionInput["agents"] = {
    lead: agent("lead", "lead", { teamId: "t1" }),
    pip: agent("pip", "teammate", { teamId: "t1" }),
    direct: agent("direct", "subagent", { parentAgentId: "lead" }),
    directDeep: agent("directDeep", "subagent", { parentAgentId: "direct" }),
    viaPip: agent("viaPip", "subagent", { parentAgentId: "pip" }),
    viaPipDeep: agent("viaPipDeep", "subagent", { parentAgentId: "viaPip" }),
  };
  const attribute = (...ids: string[]) =>
    crewAttribution({
      agents: family,
      teams: { t1: { leadAgentId: "lead" } },
      attention: ids.map(stuck),
    });

  it("keeps a subagent of a teammate and a nested one, at any depth", () => {
    const out = attribute("viaPip", "viaPipDeep");
    expect(out.dots.lead).toEqual(["viaPip", "viaPipDeep"]);
    expect(leadDotTargets(out, family, "lead")).toEqual(["viaPip", "viaPipDeep"]);
  });

  it("drops red agents directly under the lead, which SubagentCrew already dots", () => {
    const out = attribute("direct", "directDeep");
    expect(out.dots.lead).toEqual(["direct", "directDeep"]);
    expect(leadDotTargets(out, family, "lead")).toEqual([]);
  });

  it("keeps only the teammate-side ids when both sides are red", () => {
    const out = attribute("direct", "pip", "viaPip");
    expect(leadDotTargets(out, family, "lead")).toEqual(["pip", "viaPip"]);
  });

  it("returns nothing for a lead with no dots", () => {
    expect(leadDotTargets(attribute(), family, "lead")).toEqual([]);
  });
});
