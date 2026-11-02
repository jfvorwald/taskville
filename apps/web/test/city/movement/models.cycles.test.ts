import { describe, expect, it } from "vitest";
import type { Placement } from "../../../src/city/agents/index.ts";
import { DEFAULT_ACTIVITY_AREAS } from "../../../src/city/movement/areas.ts";
import { buildModels } from "../../../src/city/movement/models.ts";
import type { Agent } from "../../../src/data/domain.ts";

// Subagents that name each other as parent (a loop in the recorded data) have no door to walk out
// of, and a crew bot anchored on a bot that is itself anchored on the first would never be placed.
// Each must still be drawn exactly once: as a block agent.

const T = "2026-10-31T10:00:00.000Z";

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

const sub = (id: string, parentAgentId: string): Agent =>
  agent(id, { kind: "subagent", parentAgentId, role: "Explore" });

const pool = () => {
  const placements = new Map<string, Placement>();
  return (id: string) => {
    let p = placements.get(id);
    if (!p) {
      p = { x: 0, y: 0, z: 0, heading: 0 };
      placements.set(id, p);
    }
    return p;
  };
};

const build = (agents: Agent[]) =>
  buildModels({ agents, activity: {}, attention: [] }, DEFAULT_ACTIVITY_AREAS, pool());

describe("buildModels and a loop of parents", () => {
  const lead = agent("lead", { kind: "lead" });

  it("keeps two subagents that name each other as block agents, and nothing in the crew", () => {
    const { views, crew, intents } = build([
      lead,
      sub("kid", "lead"),
      sub("p", "q"),
      sub("q", "p"),
    ]);
    expect(views.map((v) => v.id)).toEqual(["lead", "p", "q"]);
    expect(crew.map((v) => v.id)).toEqual(["kid"]);
    // Navigation still knows every one of them.
    expect(intents.map((i) => i.id)).toEqual(["lead", "kid", "p", "q"]);
  });

  it("does the same for a longer loop and for a subagent that names itself", () => {
    const { views, crew } = build([
      lead,
      sub("kid", "lead"),
      sub("x", "z"),
      sub("y", "x"),
      sub("z", "y"),
      sub("me", "me"),
    ]);
    expect(views.map((v) => v.id)).toEqual(["lead", "x", "y", "z", "me"]);
    expect(crew.map((v) => v.id)).toEqual(["kid"]);
  });

  it("draws every agent once: in views or in the crew, never in both and never in neither", () => {
    const agents = [lead, sub("kid", "lead"), sub("p", "q"), sub("q", "p"), sub("me", "me")];
    const { views, crew } = build(agents);
    const drawn = [...views, ...crew].map((v) => v.id).sort();
    expect(drawn).toEqual(agents.map((a) => a.id).sort());
  });
});
