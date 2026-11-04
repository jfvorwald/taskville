import { describe, expect, it } from "vitest";
import { crewAttribution } from "../../../../src/city/crew/attention/attribution.ts";
import { applyStrictAttribution } from "../../../../src/city/crew/strict-attribution/index.ts";
import { attention, initialState, type ProjectState, reduce } from "../../../../src/data/domain.ts";
import { eventBuilder, PROJECT, registered } from "../../../data/fake-engine.ts";
import { agentBySource, agentNamed, type Replay, recordsOf, replay } from "../attention/replay.ts";

// M5.13: "Strict teammate attribution" (decision #120 D2 as an option, ARCHITECTURE 2.9).
//
// Intended interface (apps/web/src/city/crew/strict-attribution/index.ts), a pure function the
// crew layer runs on the domain slice it already reads, before M5.10's crewAttribution and any
// view that shows a guessed identity:
//
//   applyStrictAttribution({ agents, teams, attention }, strict: boolean): same shape
//
//  - strict = false returns the input object itself (the default D2: guesses shown);
//  - strict = true drops what M2.04 marked heuristic and nothing else: every attention record with
//    `heuristic: true` (the lead's red "for: <name>" state) and every agent's `heuristic`
//    suggestion (the guessed teammate name and kind), so a split-pane teammate is only its
//    unlinked session. Recorded fields (kind, teamId, parentAgentId, displayName, team members)
//    and non-heuristic attention are never touched.
//
// The fixture is the S-2 split-pane recording replayed through the real adapter and reducer.
// Run:
//   pnpm --filter @taskville/web exec vitest run --root ../.. --project @taskville/web \
//     test/city/crew/strict-attribution

const view = (r: Replay) => ({
  agents: r.state.agents,
  teams: r.state.teams,
  attention: recordsOf(r),
});
const PIP_SESSION = "cf7d0732-a271-4cf7-9a11-d0918b72fbd0";

describe("heuristic red state (split-pane fixture seq 17, a worker permission prompt)", () => {
  const stuck = replay("team/split-pane", { upTo: 17 });
  const input = view(stuck);
  const lead = agentNamed(stuck.state, "lead", "proj");

  it("is shown while strict is off, with the 'for: pip' label", () => {
    const out = applyStrictAttribution(input, false);
    expect(out).toBe(input);
    expect(crewAttribution(out).red).toEqual([lead.id]);
    expect(crewAttribution(out).forLabels[lead.id]).toEqual({ text: "for: pip", heuristic: true });
  });

  it("is hidden while strict is on: no red agent and no 'for:' label", () => {
    const out = crewAttribution(applyStrictAttribution(input, true));
    expect(out).toEqual({ red: [], dots: {}, forLabels: {} });
  });

  it("is restored when strict is turned off again", () => {
    applyStrictAttribution(input, true);
    expect(crewAttribution(applyStrictAttribution(input, false)).red).toEqual([lead.id]);
  });

  it("does not mutate its input", () => {
    const before = JSON.stringify(input);
    applyStrictAttribution(input, true);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("heuristic link (split-pane fixture seq 40: pip named by its first SendMessage)", () => {
  const named = replay("team/split-pane", { upTo: 40 });
  const input = view(named);
  const pip = agentBySource(named.state, PIP_SESSION);

  it("starts as an unlinked session carrying a guess, shown while strict is off", () => {
    expect(pip).toMatchObject({ kind: "session", heuristic: { displayName: "pip" } });
    expect(pip.teamId).toBeUndefined();
    expect(applyStrictAttribution(input, false).agents[pip.id]?.heuristic).toEqual(pip.heuristic);
  });

  it("drops the guess while strict is on and leaves a plain unlinked session", () => {
    const strictPip = applyStrictAttribution(input, true).agents[pip.id];
    expect(strictPip).toBeDefined();
    expect(strictPip?.heuristic).toBeUndefined();
    expect(strictPip).toMatchObject({ kind: "session", displayName: pip.displayName });
    expect(strictPip?.teamId).toBeUndefined();
  });

  it("hides no agent: the session stays in the agent list", () => {
    const strict = applyStrictAttribution(input, true);
    expect(Object.keys(strict.agents).sort()).toEqual(Object.keys(input.agents).sort());
  });
});

describe("recorded links still show when strict (split-pane fixture, full stream)", () => {
  const done = replay("team/split-pane");
  const input = view(done);
  const pip = agentBySource(done.state, PIP_SESSION);

  it("keeps the recorded teammate kind, name, team and membership", () => {
    const strict = applyStrictAttribution(input, true);
    expect(strict.agents[pip.id]).toMatchObject({
      kind: "teammate",
      displayName: "pip",
      teamId: pip.teamId,
    });
    expect(strict.teams[pip.teamId as string]?.memberAgentIds).toContain(pip.id);
    expect(strict.teams).toEqual(input.teams);
  });

  it("keeps a recorded (non-heuristic) lead prompt red with no label (in-process fixture seq 37)", () => {
    const r = replay("team/in-process", { upTo: 37 });
    const lead = agentNamed(r.state, "lead", "proj");
    const out = crewAttribution(applyStrictAttribution(view(r), true));
    expect(out.red).toContain(lead.id);
    expect(out.forLabels).toEqual({});
  });
});

// Round 3 (roborev 6812): strict drops only heuristic records that attribute a teammate's state
// to another agent: a heuristic `needs_you` (the split-pane worker prompt on the lead). Heuristic
// silence trouble ("quiet for 11 min") is about the agent itself and stays.
describe("heuristic silence trouble under strict (M5.13 round 3)", () => {
  const emit = eventBuilder();
  const base = [...registered(emit, "lead", "quiet"), emit("agent.connected", "quiet")].reduce(
    reduce,
    initialState(PROJECT),
  );
  const state = {
    ...base,
    requests: {
      r1: {
        id: "r1",
        agentId: "lead",
        kind: "permission",
        answerable: false,
        openedAt: "2026-10-30T10:00:20.868Z",
        state: "open",
        late: false,
        mergedRequestIds: [],
        heuristic: true,
        reason: { text: "for: pip (Bash)", masked: false, truncated: false },
      },
    },
  } as unknown as ProjectState;
  const now = Date.parse("2026-10-30T10:30:00.000Z");
  const input = { agents: state.agents, teams: state.teams, attention: attention(state, now) };
  const silent = input.attention.filter((r) => r.agentId === "quiet");

  it("premise: the quiet agent has heuristic silent trouble and the lead a heuristic prompt", () => {
    expect(silent).toMatchObject([{ level: "trouble", kind: "silent", heuristic: true }]);
    expect(input.attention.find((r) => r.agentId === "lead")).toMatchObject({
      level: "needs_you",
      heuristic: true,
    });
  });

  it("keeps the silent agent's trouble record when strict is on", () => {
    const out = applyStrictAttribution(input, true);
    expect(out.attention.filter((r) => r.agentId === "quiet")).toEqual(silent);
  });

  it("still drops the split-pane worker prompt's needs_you on the lead (pin)", () => {
    const out = applyStrictAttribution(input, true);
    expect(out.attention.filter((r) => r.level === "needs_you")).toEqual([]);
    expect(out.attention).toHaveLength(silent.length);
  });
});
