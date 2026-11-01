import { describe, expect, it } from "vitest";
import { FADE_MS, HAND_OVER_MS, RETURN_MS } from "../../../../src/city/crew/subagents/lifecycle.ts";
import { createCrewTracker } from "../../../../src/city/crew/subagents/tracker.ts";
import type { Agent } from "../../../../src/data/domain.ts";

// The crew tracker turns the store's agents into the families the crew layer draws. A family is
// the bots of one immediate parent; a finished subagent is dropped once it has faded.

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

const memberIds = (families: ReturnType<ReturnType<typeof createCrewTracker>["sync"]>) =>
  families.flatMap((f) => f.members.map((m) => m.id));

describe("crew families", () => {
  it("groups a nested subagent under its immediate parent, not under the grandparent", () => {
    const tracker = createCrewTracker();
    const families = tracker.sync(
      [agent("lead", { kind: "lead" }), sub("child", "lead"), sub("grandchild", "child")],
      0,
    );

    const ofLead = families.find((f) => f.parentId === "lead");
    const ofChild = families.find((f) => f.parentId === "child");
    expect(ofLead?.members.map((m) => m.id)).toEqual(["child"]);
    expect(ofLead?.parentGeneration).toBe(0);
    expect(ofChild?.members.map((m) => m.id)).toEqual(["grandchild"]);
    expect(ofChild?.members[0]?.generation).toBe(2);
    expect(ofChild?.parentGeneration).toBe(1);
    expect(families).toHaveLength(2);
  });

  it("lists the family of a parent before the family of its bot", () => {
    const tracker = createCrewTracker();
    const families = tracker.sync(
      [agent("lead", { kind: "lead" }), sub("child", "lead"), sub("grandchild", "child")],
      0,
    );
    expect(families.map((f) => f.parentId)).toEqual(["lead", "child"]);
  });
});

describe("crew tracker and subagents with a missing parent", () => {
  it("draws no crew bot for a subagent whose parent is not in the store (it stays a block agent)", () => {
    // `buildModels` keeps the block view of such a subagent, so the crew layer must not draw it
    // a second time. A subagent whose parent is present is still drawn.
    const tracker = createCrewTracker();
    const families = tracker.sync(
      [agent("lead", { kind: "lead" }), sub("kid", "lead"), sub("lost", "nobody")],
      0,
    );
    expect(memberIds(families)).toEqual(["kid"]);
    expect(families.map((f) => f.parentId)).not.toContain("nobody");
  });
});

describe("crew tracker retention", () => {
  it("keeps a finished subagent through its walk home and fade", () => {
    const tracker = createCrewTracker();
    const lead = agent("lead", { kind: "lead" });
    tracker.sync([lead, sub("s1", "lead")], 0);
    const finished = [lead, sub("s1", "lead", { finishedAt: T })];
    expect(memberIds(tracker.sync(finished, 1000))).toEqual(["s1"]);

    const late = 1000 + VISIT_MS - 1;
    expect(memberIds(tracker.sync(finished, late))).toEqual(["s1"]);
    expect(tracker.frame("s1", late)?.phase).toBe("fading");
  });

  it("drops a finished subagent once it has faded, so history costs nothing", () => {
    const tracker = createCrewTracker();
    const lead = agent("lead", { kind: "lead" });
    tracker.sync([lead, sub("s1", "lead")], 0);
    const finished = [lead, sub("s1", "lead", { finishedAt: T })];
    tracker.sync(finished, 1000);

    const after = 1000 + VISIT_MS;
    expect(tracker.sync(finished, after)).toEqual([]);
    // No state is kept for it: not a "gone" frame, no frame at all.
    expect(tracker.frame("s1", after)).toBeUndefined();
    // It stays in the store's list, and a later sync must not bring it back.
    expect(tracker.sync(finished, after + 60_000)).toEqual([]);
    expect(tracker.frame("s1", after + 60_000)).toBeUndefined();
  });

  it("keeps tracking the others when one subagent has been dropped", () => {
    const tracker = createCrewTracker();
    const lead = agent("lead", { kind: "lead" });
    tracker.sync([lead, sub("s1", "lead"), sub("s2", "lead")], 0);
    const next = [lead, sub("s1", "lead", { finishedAt: T }), sub("s2", "lead")];
    tracker.sync(next, 1000);
    const families = tracker.sync(next, 1000 + VISIT_MS);
    expect(memberIds(families)).toEqual(["s2"]);
    expect(tracker.frame("s2", 1000 + VISIT_MS)?.phase).toBe("working");
  });
});
