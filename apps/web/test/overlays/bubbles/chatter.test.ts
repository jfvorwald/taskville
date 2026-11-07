import { describe, expect, it } from "vitest";
import {
  type AgentBreak,
  BUBBLE_TURN_MS,
  type Conversation,
} from "../../../src/city/breaks/types.ts";
import {
  type BreakBubbleInput,
  selectBubblesWithBreaks,
} from "../../../src/overlays/bubbles/chatter.ts";
import type { BubbleCandidate } from "../../../src/overlays/bubbles/select.ts";
import { pickActivityLine, pickBanterLine } from "../../../src/quips/banter.ts";

// M9.03: conversation bubbles under the three-bubble cap. Needs-you, trouble and the selected
// agent always outrank chatter; one conversation shows; only its current speaker; chatter off
// shows none; an activity line shows only for the selected agent on break with no conversation.

const NOW = 2_000_000;
const theme = "cyberpunk";
const options = { selectedAgentId: undefined, now: NOW, theme } as const;

const cand = (
  agentId: string,
  level: BubbleCandidate["level"],
  waitMs = 5000,
): BubbleCandidate => ({ agentId, eventId: `evt-${agentId}`, level, sinceMs: NOW - waitMs });

const convo = (a: string, b: string, turn = 0): Conversation => ({
  a,
  b,
  siteId: "bar-1",
  turn,
  turnStartedAt: NOW - 1000,
});

const onBreak = (
  activity: AgentBreak["activity"] = "bar",
  startedAt = NOW - 30_000,
): AgentBreak => ({
  activity,
  siteId: activity === "bar" ? "bar-1" : null,
  spot: 0,
  startedAt,
  endsAt: startedAt + 200_000,
});

const breaks = (
  conversations: Conversation[],
  agentIds: string[] = [],
  chatterEnabled = true,
): BreakBubbleInput => ({
  conversations,
  agents: new Map(agentIds.map((id) => [id, onBreak()])),
  chatterEnabled,
});

const ids = (out: readonly { agentId: string }[]) => out.map((b) => b.agentId);

describe("selectBubblesWithBreaks", () => {
  it("shows only the current speaker of a conversation (even turn: a)", () => {
    const c = convo("alpha", "bravo", 0);
    const out = selectBubblesWithBreaks([], breaks([c], ["alpha", "bravo"]), options);
    expect(out).toHaveLength(1);
    expect(out[0]?.agentId).toBe("alpha");
    expect(out[0]?.level).toBe("chatter");
    expect(out[0]?.line).toBe(pickBanterLine({ conversation: c, theme }).line);
  });

  it("alternates to b on an odd turn", () => {
    const c = convo("alpha", "bravo", 1);
    const out = selectBubblesWithBreaks([], breaks([c], ["alpha", "bravo"]), options);
    expect(ids(out)).toEqual(["bravo"]);
    expect(out[0]?.line).toBe(pickBanterLine({ conversation: c, theme }).line);
  });

  it("shows no chatter when chatter is disabled", () => {
    const c = convo("alpha", "bravo");
    const out = selectBubblesWithBreaks([], breaks([c], ["alpha", "bravo"], false), options);
    expect(out).toEqual([]);
  });

  it("shows only one conversation, the lowest a id", () => {
    const out = selectBubblesWithBreaks(
      [],
      breaks([convo("mike", "nora"), convo("alpha", "bravo"), convo("kilo", "lima")]),
      options,
    );
    expect(ids(out)).toEqual(["alpha"]);
  });

  it("a needs-you bubble always wins a slot over chatter", () => {
    const full = [cand("n1", "needs_you"), cand("n2", "needs_you"), cand("n3", "needs_you")];
    const out = selectBubblesWithBreaks(full, breaks([convo("alpha", "bravo")]), options);
    expect(ids(out)).toEqual(["n1", "n2", "n3"]);
  });

  it("trouble and needs-you take their slots; chatter fills only what is left", () => {
    const two = [cand("n1", "needs_you"), cand("t1", "trouble")];
    const out = selectBubblesWithBreaks(two, breaks([convo("alpha", "bravo")]), options);
    expect(ids(out)).toEqual(["n1", "t1", "alpha"]);
    const three = [...two, cand("t2", "trouble")];
    expect(ids(selectBubblesWithBreaks(three, breaks([convo("alpha", "bravo")]), options))).toEqual(
      ["n1", "t1", "t2"],
    );
  });

  it("the selected agent's waiting bubble outranks chatter", () => {
    const list = [cand("n1", "needs_you"), cand("t1", "trouble"), cand("sel", "waiting")];
    const out = selectBubblesWithBreaks(list, breaks([convo("alpha", "bravo")]), {
      ...options,
      selectedAgentId: "sel",
    });
    expect(ids(out)).toEqual(["n1", "t1", "sel"]);
  });

  it("never exceeds three bubbles", () => {
    const list = [cand("n1", "needs_you"), cand("n2", "needs_you")];
    const out = selectBubblesWithBreaks(list, breaks([convo("alpha", "bravo")], ["sel"]), {
      ...options,
      selectedAgentId: "sel",
    });
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("is deterministic: the same inputs give the same bubbles (replay equals live)", () => {
    const list = [cand("n1", "needs_you")];
    const b = breaks([convo("alpha", "bravo", 2)], ["alpha", "bravo"]);
    const first = selectBubblesWithBreaks(list, b, options);
    expect(selectBubblesWithBreaks(list, b, options)).toEqual(first);
    // Same turn, later in the turn: the same line.
    const later = selectBubblesWithBreaks(list, b, { ...options, now: NOW + BUBBLE_TURN_MS / 2 });
    expect(later.map((x) => x.line)).toEqual(first.map((x) => x.line));
  });
});

describe("activity lines", () => {
  it("shows for the selected agent on break with no conversation", () => {
    const b = breaks([], ["loner"]);
    const out = selectBubblesWithBreaks([], b, { ...options, selectedAgentId: "loner" });
    expect(ids(out)).toEqual(["loner"]);
    expect(out[0]?.level).toBe("activity");
    expect(out[0]?.line).toBe(
      pickActivityLine({
        agentId: "loner",
        activity: "bar",
        startedAt: NOW - 30_000,
        theme,
      }),
    );
  });

  it("does not show when the agent is not selected", () => {
    expect(selectBubblesWithBreaks([], breaks([], ["loner"]), options)).toEqual([]);
    expect(
      selectBubblesWithBreaks([], breaks([], ["loner"]), { ...options, selectedAgentId: "other" }),
    ).toEqual([]);
  });

  it("does not show for a selected agent that is in a conversation", () => {
    const b = breaks([convo("alpha", "bravo", 1)], ["alpha", "bravo"]);
    const out = selectBubblesWithBreaks([], b, { ...options, selectedAgentId: "alpha" });
    expect(out.filter((x) => x.level === "activity")).toEqual([]);
  });

  it("is not suppressed by the chatter setting", () => {
    const b = breaks([], ["loner"], false);
    const out = selectBubblesWithBreaks([], b, { ...options, selectedAgentId: "loner" });
    expect(ids(out)).toEqual(["loner"]);
  });
});
