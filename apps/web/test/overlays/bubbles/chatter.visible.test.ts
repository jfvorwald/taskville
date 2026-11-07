import { describe, expect, it } from "vitest";
import type { Conversation } from "../../../src/city/breaks/types.ts";
import { selectBubblesWithBreaks } from "../../../src/overlays/bubbles/chatter.ts";

// roborev 7349: the chatter conversation is the first one (lowest a, then b) whose CURRENT speaker
// is visible. `BreakBubbleInput.isVisible(agentId)` (default: everyone visible) is the predicate;
// Bubbles passes the anchor projection's visibility. An offscreen first conversation must not
// hide a visible one.

const NOW = 2_000_000;
const convo = (a: string, b: string, turn = 0): Conversation => ({
  a,
  b,
  siteId: "bar-1",
  turn,
  turnStartedAt: NOW - 1000,
});
const options = { selectedAgentId: undefined, now: NOW, theme: "cyberpunk" } as const;
const run = (conversations: Conversation[], visible: readonly string[]) =>
  selectBubblesWithBreaks(
    [],
    {
      conversations,
      agents: new Map(),
      chatterEnabled: true,
      isVisible: (id: string) => visible.includes(id),
    } as never,
    options,
  ).map((b) => b.agentId);

describe("chatter conversation choice with visibility", () => {
  it("skips a first conversation whose speaker is offscreen for a visible one", () => {
    expect(run([convo("a1", "b1"), convo("a2", "b2")], ["a2", "b2"])).toEqual(["a2"]);
  });

  it("looks at the current speaker, not the pair (turn 1: b speaks)", () => {
    expect(run([convo("a1", "b1", 1), convo("a2", "b2", 0)], ["a1", "a2"])).toEqual(["a2"]);
  });

  it("shows nothing when no conversation's speaker is visible", () => {
    expect(run([convo("a1", "b1"), convo("a2", "b2")], [])).toEqual([]);
  });

  it("keeps the first conversation when its speaker is visible", () => {
    expect(run([convo("a2", "b2"), convo("a1", "b1")], ["a1", "a2"])).toEqual(["a1"]);
  });
});
