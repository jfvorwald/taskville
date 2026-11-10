import { describe, expect, it } from "vitest";
import { agentLabel, breakNote } from "../../../src/city/agents/label.ts";
import type { AgentView, AttentionView } from "../../../src/city/agents/types.ts";

// M9.04: `breakNote(status, onBreak)` in city/agents/label.ts. `status` is the text `agentLabel`
// gives. It returns the secondary note "on break" only for an agent whose label reads "Waiting" or
// "Idle" (a normal Stop leaves waiting attention but idle activity) and whose break flag is set;
// otherwise null. The status itself never changes: a
// waiting agent on break still reads "Waiting" (ARCHITECTURE 2.2, constitution IV).
//   pnpm --filter @taskville/web exec vitest run --root ../.. --project @taskville/web \
//     test/city/agents/breakNote

function view(over: Partial<AgentView> = {}): AgentView {
  return {
    id: "agent-abcdef123456",
    kind: "session",
    activity: "idle",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
    ...over,
  };
}

const status = (over: Partial<AgentView>) => agentLabel(view(over)).status;

describe("breakNote", () => {
  it("adds 'on break' to a waiting agent on break, and the status still reads Waiting", () => {
    expect(status({ activity: "waiting" })).toBe("Waiting");
    expect(breakNote(status({ activity: "waiting" }), true)).toBe("on break");
    const waiting: AttentionView = { level: "waiting" };
    expect(breakNote(status({ attention: waiting }), true)).toBe("on break");
  });

  it("adds nothing for a waiting agent that is not on break", () => {
    expect(breakNote(status({ activity: "waiting" }), false)).toBeNull();
    expect(breakNote("Waiting", false)).toBeNull();
  });

  it("leaves the agent label exactly as today", () => {
    expect(agentLabel(view({ displayName: "Ada", activity: "waiting" }))).toEqual({
      name: "Ada",
      status: "Waiting",
    });
  });

  it("never notes needs-you, trouble or working labels, even with a stale break flag", () => {
    const cases: Partial<AgentView>[] = [
      { attention: { level: "needs_you" } },
      { activity: "waiting", attention: { level: "needs_you" } },
      { attention: { level: "trouble", detail: "quiet for 12 min" } },
      { attention: { level: "trouble", heuristic: true } },
      { activity: "waiting", attention: { level: "trouble" } },
      { activity: "implementing" },
      { activity: "testing" },
      { activity: "reviewing" },
      { activity: "researching" },
      { activity: "documenting" },
      { activity: "dispatching" },
      { activity: "handing_off" },
    ];
    for (const over of cases) {
      expect(breakNote(status(over), true), JSON.stringify(over)).toBeNull();
    }
  });

  it("notes an idle agent on break (a normal Stop reads Idle), status unchanged", () => {
    expect(status({ activity: "idle" })).toBe("Idle");
    expect(breakNote(status({ activity: "idle" }), true)).toBe("on break");
    expect(breakNote("Idle", true)).toBe("on break");
    expect(breakNote("Idle", false)).toBeNull();
  });

  it("is quiet for unknown and other labels", () => {
    expect(breakNote(status({ activity: "unknown" }), true)).toBeNull();
    expect(breakNote("Something else", true)).toBeNull();
    expect(breakNote("", true)).toBeNull();
  });
});
