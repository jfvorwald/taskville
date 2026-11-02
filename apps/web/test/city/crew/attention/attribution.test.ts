import { describe, expect, it } from "vitest";
import {
  type AttributionAgent,
  type CrewAttributionInput,
  crewAttribution,
} from "../../../../src/city/crew/attention/attribution.ts";
import { attention } from "../../../../src/data/domain.ts";
import { agentBySource, agentNamed, type Hook, type Replay, recordsOf, replay } from "./replay.ts";

// M5.10: stuck attribution for subagents and teammates (ARCHITECTURE 2.9, decision #120).
//
// Intended interface (apps/web/src/city/crew/attention/attribution.ts), a pure function from
// domain state to a visual map, so the crew layer (M5.02 SubagentCrew, M5.03 teammate visuals)
// only reads it and never re-derives attribution:
//
//   crewAttribution({ agents, teams, attention }): {
//     red:       string[]                      // agents wearing the red state, sorted
//     dots:      Record<wearerId, string[]>    // red dot per wearer: the red agents below it
//     forLabels: Record<leadId, { text, heuristic: true }>   // "for: <teammate>" on the lead
//   }
//
// Inputs are the domain's own: `state.agents`, `state.teams`, and `attention(state, now)`. Only
// `needs_you` records make red; `trouble` (amber) and `waiting` never do. Rules pinned here:
//  - red goes to the agent named by the record: the subagent or in-process teammate whose
//    `agent_id` the permission request carries (S-2 answer 3, #120 D1);
//  - a red dot goes to every ancestor reachable by a RECORDED link: a subagent's
//    `parentAgentId` chain, and a teammate's team lead. An unknown parent gets no dot, and
//    nothing is guessed (constitution IV; S-2: a synchronous child has no parent link until it
//    ends);
//  - a split-pane teammate's prompt is red on the LEAD (the record is heuristic, #120 D2) and
//    the lead shows "for: <teammate>" with `heuristic: true`; the teammate itself is not red and
//    no dot is drawn, since the lead already wears the red state;
//  - a lead's own, recorded prompt is red with no "for:" label.
//
// The fixtures are the redacted S-2 recordings under fixtures/claude-code, replayed through the
// real adapter and reducer (see replay.ts). The adapter does not map PermissionRequest (that is
// the M4 bridge), so where a fixture hook is a tool call that prompted, the helper stands in for
// the bridge with the hook's own agent. Run:
//   pnpm --filter @taskville/web exec vitest run --root ../.. --project @taskville/web \
//     test/city/crew/attention

const attribute = (r: Replay) =>
  crewAttribution({
    agents: r.state.agents,
    teams: r.state.teams,
    attention: recordsOf(r),
  });

/** The bridge opens a request for `sourceAgentId` when hook `seq` (its tool call) arrives. */
const promptAt = (seq: number, sourceAgentId: string) => (hook: Hook, state: Replay["state"]) =>
  hook.seq === seq ? { agent: agentBySource(state, sourceAgentId), tool: "Bash" } : undefined;

const INNER = "a0c1bc9a2c30e80b6";
const SUB_A = "afdf84bea07a9064c";
const SUB_B = "a0b4668e13e056653";
const PIP = "apip-5cb5e9bb3f2f1097";

describe("a subagent that needs you (S-2 subagent/parallel)", () => {
  const stuck = replay("subagent/parallel", { upTo: 8, bridge: promptAt(8, SUB_A) });
  const { state } = stuck;
  const a = agentBySource(state, SUB_A);
  const b = agentBySource(state, SUB_B);
  const parent = agentBySource(state, "1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5");

  it("turns only that subagent red, not its sibling or its parent", () => {
    expect(attribute(stuck).red).toEqual([a.id]);
    expect(attribute(stuck).red).not.toContain(b.id);
    expect(attribute(stuck).red).not.toContain(parent.id);
  });

  it("puts a red dot on its parent that names the stuck child", () => {
    expect(a.parentAgentId).toBe(parent.id);
    expect(attribute(stuck).dots).toEqual({ [parent.id]: [a.id] });
  });

  it("shows no 'for:' label for a recorded subagent prompt", () => {
    expect(attribute(stuck).forLabels).toEqual({});
  });

  it("clears everything before the request and when only waiting states remain", () => {
    const before = attribute(replay("subagent/parallel", { upTo: 8 }));
    expect(before).toEqual({ red: [], dots: {}, forLabels: {} });

    // After the parent's Stop (fixture seq 24) its turn has ended: a "waiting" record, never red.
    const full = replay("subagent/parallel", { upTo: 24 });
    const records = attention(full.state, full.now);
    expect(records.map((r) => r.level)).toContain("waiting");
    const out = crewAttribution({
      agents: full.state.agents,
      teams: full.state.teams,
      attention: records,
    });
    expect(out).toEqual({ red: [], dots: {}, forLabels: {} });
  });

  it("lists both children when both need you, sorted, under one dot", () => {
    const both = replay("subagent/parallel", {
      upTo: 10,
      bridge: (hook, s) =>
        hook.seq === 8
          ? promptAt(8, SUB_A)(hook, s)
          : hook.seq === 10
            ? promptAt(10, SUB_B)(hook, s)
            : undefined,
    });
    const ids = [a.id, b.id].sort();
    expect(attribute(both).red).toEqual(ids);
    expect(attribute(both).dots).toEqual({ [parent.id]: ids });
  });
});

describe("a nested subagent whose parent link is not recorded yet (S-2 subagent/nested)", () => {
  // inner's PreToolUse (seq 9) comes before outer's PostToolUse(Agent), the only recorded link
  // (S-2: a synchronous child's parent is unknown for its whole life). outer is linked already.
  const stuck = replay("subagent/nested", { upTo: 9, bridge: promptAt(9, INNER) });
  const inner = agentBySource(stuck.state, INNER);

  it("turns the inner subagent red", () => {
    expect(inner.parentAgentId).toBeUndefined();
    expect(attribute(stuck).red).toEqual([inner.id]);
  });

  it("draws no dot anywhere, because no recorded link says whose child it is", () => {
    expect(attribute(stuck).dots).toEqual({});
  });
});

describe("an in-process teammate that needs you (S-2 team/in-process, #120 D1)", () => {
  // pip's Bash hits the ask rule: PermissionRequest carries pip's agent_id (fixture seq 31).
  const stuck = replay("team/in-process", { upTo: 31, bridge: promptAt(31, PIP) });
  const pip = agentNamed(stuck.state, "teammate", "pip");
  const bo = agentNamed(stuck.state, "teammate", "bo");
  const lead = agentNamed(stuck.state, "lead", "proj");

  it("turns pip red and nobody else on the team", () => {
    expect(pip.sourceAgentId).toBe(PIP);
    const { red } = attribute(stuck);
    expect(red).toContain(pip.id);
    expect(red).not.toContain(bo.id);
  });

  it("puts a red dot on the lead for pip", () => {
    expect(attribute(stuck).dots).toEqual({ [lead.id]: [pip.id] });
  });

  it("shows no 'for:' label, because the attribution is direct", () => {
    expect(attribute(stuck).forLabels).toEqual({});
  });
});

describe("a split-pane teammate that needs you (S-2 team/split-pane, #120 D2)", () => {
  // Fixture seq 17: no PermissionRequest fires; the lead gets a worker_permission_prompt
  // notification "pip needs permission for Bash". pip's own session is not linked to the team yet.
  const stuck = replay("team/split-pane", { upTo: 17 });
  const lead = agentNamed(stuck.state, "lead", "proj");

  it("turns the lead red, not any teammate or unlinked session", () => {
    expect(attribute(stuck).red).toEqual([lead.id]);
  });

  it("labels the lead 'for: pip' and marks the label heuristic", () => {
    expect(attribute(stuck).forLabels).toEqual({
      [lead.id]: { text: "for: pip", heuristic: true },
    });
  });

  it("draws no dot, since the lead itself wears the red state", () => {
    expect(attribute(stuck).dots).toEqual({});
  });

  it("drops the label and the red state when the turn ends (fixture seq 33)", () => {
    const after = attribute(replay("team/split-pane"));
    expect(after).toEqual({ red: [], dots: {}, forLabels: {} });
  });
});

describe("a lead's own prompt in an in-process team (S-2 team/in-process seq 37)", () => {
  it("is red with no 'for:' label, because a recorded prompt is not indirect", () => {
    const r = replay("team/in-process", { upTo: 37 });
    const lead = agentNamed(r.state, "lead", "proj");
    const out = attribute(r);
    expect(out.red).toContain(lead.id);
    expect(out.forLabels).toEqual({});
  });
});

// Shapes the fixtures do not record (a subagent below a teammate, an unnamed worker prompt),
// built by hand so the rules are pinned without inventing a recording.
describe("hand-built families", () => {
  const agent = (
    id: string,
    kind: string,
    extra: Partial<AttributionAgent> = {},
  ): AttributionAgent => ({
    id,
    kind,
    ...extra,
  });
  const needsYou = (agentId: string, heuristic = false, text?: string) => ({
    agentId,
    level: "needs_you" as const,
    kind: "permission" as const,
    since: "2026-10-30T12:00:00.000Z",
    heuristic,
    requestId: `r-${agentId}`,
    ...(text === undefined ? {} : { reason: { text, masked: false, truncated: false } }),
  });
  const family = (attentionRecords: CrewAttributionInput["attention"]): CrewAttributionInput => ({
    agents: {
      lead: agent("lead", "lead", { teamId: "t1" }),
      pip: agent("pip", "teammate", { teamId: "t1", displayName: "pip" }),
      s1: agent("s1", "subagent", { parentAgentId: "pip" }),
      s2: agent("s2", "subagent", { parentAgentId: "s1" }),
    },
    teams: { t1: { leadAgentId: "lead" } },
    attention: attentionRecords,
  });

  it("gives every recorded ancestor a dot: subagent chain, then teammate, then lead", () => {
    const out = crewAttribution(family([needsYou("s2")]));
    expect(out.red).toEqual(["s2"]);
    expect(out.dots).toEqual({ s1: ["s2"], pip: ["s2"], lead: ["s2"] });
  });

  it("sorts red agents and dot targets, and lists each red agent once per wearer", () => {
    const out = crewAttribution(family([needsYou("s2"), needsYou("pip"), needsYou("s2")]));
    expect(out.red).toEqual(["pip", "s2"]);
    expect(out.dots).toEqual({ lead: ["pip", "s2"], pip: ["s2"], s1: ["s2"] });
  });

  it("falls back to 'for: a teammate' when the notification gave no name", () => {
    const out = crewAttribution(family([needsYou("lead", true, "for: a teammate (Bash)")]));
    expect(out.forLabels).toEqual({ lead: { text: "for: a teammate", heuristic: true } });
    expect(out.red).toEqual(["lead"]);
  });

  it("ignores trouble and waiting records", () => {
    const amber = { ...needsYou("s1"), level: "trouble" as const, kind: "silent" as const };
    const waiting = { ...needsYou("pip"), level: "waiting" as const, kind: "turn_ended" as const };
    expect(crewAttribution(family([amber, waiting]))).toEqual({ red: [], dots: {}, forLabels: {} });
  });

  it("skips a record for an agent it does not know instead of throwing", () => {
    const out = crewAttribution(family([needsYou("ghost")]));
    expect(out).toEqual({ red: [], dots: {}, forLabels: {} });
  });
});
