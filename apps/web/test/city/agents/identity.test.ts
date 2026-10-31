import { describe, expect, it } from "vitest";
import { agentColors, identityKey } from "../../../src/city/agents/identity.ts";
import type { AgentView } from "../../../src/city/agents/types.ts";

const HEX = /^#[0-9a-f]{6}$/;

function view(over: Partial<AgentView> & { id: string }): AgentView {
  return {
    kind: "session",
    activity: "idle",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
    ...over,
  };
}

describe("identity key", () => {
  it("uses source identity when registered, else the agent id", () => {
    expect(identityKey(view({ id: "a1", sourceId: "cc", sourceAgentId: "s-9" }))).toBe("cc:s-9");
    expect(identityKey(view({ id: "a1" }))).toBe("id:a1");
  });

  it("keys a teammate by team and name so it survives a new agent id", () => {
    const a = view({ id: "a1", kind: "teammate", teamId: "t1", displayName: "reviewer" });
    const b = view({ id: "a2", kind: "teammate", teamId: "t1", displayName: "reviewer" });
    expect(identityKey(a)).toBe(identityKey(b));
    expect(identityKey(a)).not.toBe(
      identityKey(view({ id: "a1", kind: "teammate", teamId: "t2", displayName: "reviewer" })),
    );
  });
});

describe("agentColors", () => {
  it("is stable for one identity across calls and across unrelated view changes", () => {
    const a = view({ id: "a1", sourceId: "cc", sourceAgentId: "s-1" });
    const first = agentColors(a);
    expect(agentColors(a)).toEqual(first);
    expect(agentColors({ ...a, activity: "testing", displayName: "renamed" })).toEqual(first);
  });

  it("returns well-formed hex colors", () => {
    const c = agentColors(view({ id: "a1" }));
    expect(c.body).toMatch(HEX);
    expect(c.trim).toMatch(HEX);
  });

  it("separates distinct identities", () => {
    const bodies = new Set<string>();
    for (let i = 0; i < 24; i++) bodies.add(agentColors(view({ id: `agent-${i}` })).body);
    expect(bodies.size).toBeGreaterThanOrEqual(20);
  });

  it("colors a subagent body by agent type and its trim by the parent", () => {
    const parent = view({ id: "p1", sourceId: "cc", sourceAgentId: "main" });
    const sub = (id: string, agentType: string) =>
      view({ id, kind: "subagent", agentType, parentIdentity: identityKey(parent) });
    const x = agentColors(sub("s1", "Explore"));
    const y = agentColors(sub("s2", "Explore"));
    const z = agentColors(sub("s3", "Plan"));
    expect(x).toEqual(y);
    expect(z.body).not.toBe(x.body);
    expect(z.trim).toBe(x.trim);
    expect(x.trim).toBe(agentColors(parent).body);
  });

  it("gives a teammate the shared team scarf color", () => {
    const a = agentColors(view({ id: "a1", kind: "teammate", teamId: "t1", displayName: "x" }));
    const b = agentColors(view({ id: "a2", kind: "teammate", teamId: "t1", displayName: "y" }));
    expect(a.trim).toBe(b.trim);
    expect(a.body).not.toBe(b.body);
  });
});
