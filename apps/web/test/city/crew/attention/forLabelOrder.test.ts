import { describe, expect, it } from "vitest";
import { crewAttribution } from "../../../../src/city/crew/attention/attribution.ts";
import { agentNamed, readFixture, recordsOf, replay } from "./replay.ts";

// M5.10 red round 3 (roborev job 6619, medium at attribution.ts:68). The reducer keeps two split-
// pane teammates' worker prompts as two separate heuristic needs_you records on the same lead
// (requests.ts mergeTarget: "two heuristic worker prompts never merge"). The lead's action card
// shows the FIRST needs_you record, in `attention()` order (oldest `since` first). The "for:"
// label must come from that same record, not the last one in the list.
//
// Scenario: S-2 team/split-pane seq 17 ("pip needs permission for Bash"), then a second worker
// notification cloned from that hook for bo one second later (the recordings hold only one).

describe("the lead's 'for:' label with two open worker prompts", () => {
  const first = readFixture("team/split-pane").find((h) => h.seq === 17);
  if (first === undefined) throw new Error("fixture seq 17 missing");
  const second = {
    ...first,
    seq: 1017,
    offsetMs: first.offsetMs + 1000,
    input: { ...first.input, message: "bo needs permission for Read" },
  };
  const stuck = replay("team/split-pane", { upTo: 17, extra: [second] });
  const lead = agentNamed(stuck.state, "lead", "proj");
  const records = recordsOf(stuck).filter((r) => r.level === "needs_you" && r.agentId === lead.id);

  it("starts from two separate heuristic records on the lead (precondition)", () => {
    expect(records.map((r) => r.reason?.text)).toEqual(["for: pip (Bash)", "for: bo (Read)"]);
    expect(records.every((r) => r.heuristic)).toBe(true);
  });

  it("labels the lead from the first record, the one the action card uses", () => {
    const out = crewAttribution({
      agents: stuck.state.agents,
      teams: stuck.state.teams,
      attention: recordsOf(stuck),
    });
    expect(out.forLabels[lead.id]).toEqual({ text: "for: pip", heuristic: true });
  });
});
