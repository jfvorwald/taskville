import { describe, expect, it } from "vitest";
import { FADE_MS, HAND_OVER_MS, RETURN_MS } from "../../../../src/city/crew/subagents/lifecycle.ts";
import { createCrewTracker } from "../../../../src/city/crew/subagents/tracker.ts";
import type { Agent } from "../../../../src/data/domain.ts";

// Generation 3 and below get no bot (ARCHITECTURE 2.9: "below two levels shown as a count on the
// parent"): the running ones are counted on the generation 2 bot that owns them. And agents that
// name each other as parent have no door to walk out of, so the crew layer draws neither.

const T = "2026-10-31T10:00:00.000Z";
const VISIT_MS = RETURN_MS + HAND_OVER_MS + FADE_MS;

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    sourceId: "demo:7",
    sourceAgentId: id,
    displayName: id.toUpperCase(),
    kind: "session",
    registered: true,
    connection: "connected",
    firstSeenAt: T,
    lastSeenAt: T,
    toolCallCount: 0,
    consecutiveToolFailures: 0,
    ...extra,
  } as Agent;
}

const sub = (id: string, parentAgentId: string, extra: Partial<Agent> = {}): Agent =>
  agent(id, { kind: "subagent", parentAgentId, role: "Explore", ...extra });

type Families = ReturnType<ReturnType<typeof createCrewTracker>["sync"]>;

const LEAD = agent("lead", { kind: "lead" });
const memberIds = (families: Families) => families.flatMap((f) => f.members.map((m) => m.id));
const deepOf = (families: Families) =>
  Object.fromEntries(families.filter((f) => f.deepCount > 0).map((f) => [f.parentId, f.deepCount]));

describe("subagents too deep for a bot", () => {
  it("counts each on the generation 2 bot above it and gives it no bot of its own", () => {
    const families = createCrewTracker().sync(
      [
        LEAD,
        sub("a1", "lead"),
        sub("b1", "a1"),
        sub("c1", "b1"),
        sub("a2", "lead"),
        sub("b2", "a2"),
        sub("c2", "b2"),
        sub("d2", "c2"),
      ],
      0,
    );
    expect(deepOf(families)).toEqual({ b1: 1, b2: 2 });
    expect(memberIds(families).sort()).toEqual(["a1", "a2", "b1", "b2"]);
    // The count belongs to the family of the generation 2 bot (whose parent generation is 2).
    expect(families.find((f) => f.parentId === "b2")?.parentGeneration).toBe(2);
  });

  it("does not count a deep subagent that has finished", () => {
    const tracker = createCrewTracker();
    const chain = [LEAD, sub("a", "lead"), sub("b", "a"), sub("c", "b"), sub("d", "b")];
    expect(deepOf(tracker.sync(chain, 0))).toEqual({ b: 2 });
    const next = [
      LEAD,
      sub("a", "lead"),
      sub("b", "a"),
      sub("c", "b", { finishedAt: T }),
      sub("d", "b"),
    ];
    expect(deepOf(tracker.sync(next, 1000))).toEqual({ b: 1 });
    expect(deepOf(tracker.sync(next, 1000 + VISIT_MS + 1))).toEqual({ b: 1 });
  });

  it("counts nothing while no subagent is that deep", () => {
    const families = createCrewTracker().sync([LEAD, sub("a", "lead"), sub("b", "a")], 0);
    expect(deepOf(families)).toEqual({});
  });
});

describe("subagents that name each other as parent", () => {
  it("leaves a pair out of every family, so each is drawn only once, as a block agent", () => {
    const families = createCrewTracker().sync(
      [LEAD, sub("kid", "lead"), sub("p", "q"), sub("q", "p")],
      0,
    );
    expect(memberIds(families)).toEqual(["kid"]);
  });

  it("leaves a longer loop and an agent that names itself out of every family", () => {
    const families = createCrewTracker().sync(
      [LEAD, sub("kid", "lead"), sub("x", "z"), sub("y", "x"), sub("z", "y"), sub("me", "me")],
      0,
    );
    expect(memberIds(families)).toEqual(["kid"]);
    // Nor are they counted as "deeper" on anyone.
    expect(deepOf(families)).toEqual({});
  });
});
