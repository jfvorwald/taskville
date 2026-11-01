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

/** Hue in degrees, 0 to 360, of a `#rrggbb` color. */
function hueOf(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// ARCHITECTURE 2.2: red and amber belong to "needs you" and "trouble", so no identity color may
// look like them. Hue bands are the CTO's decision on this ticket: [345, 360), [0, 20], [30, 50].
function inReservedHue(hue: number): boolean {
  return hue >= 345 || hue <= 20 || (hue >= 30 && hue <= 50);
}

describe("identity colors avoid the attention hues", () => {
  const reserved = (hex: string) => inReservedHue(hueOf(hex));

  it("never gives a session, teammate or subagent body a red or amber hue", () => {
    const bad: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const colors = [
        agentColors(view({ id: `agent-${i}` })).body,
        agentColors(view({ id: `a${i}`, sourceId: "cc", sourceAgentId: `s-${i}` })).body,
        agentColors(view({ id: `t${i}`, kind: "teammate", teamId: "t1", displayName: `m${i}` }))
          .body,
        agentColors(view({ id: `u${i}`, kind: "subagent", agentType: `type-${i}` })).body,
      ];
      for (const c of colors) if (reserved(c)) bad.push(`${c} (hue ${Math.round(hueOf(c))})`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("keeps the hash-derived trims (team scarf, parent color) out of the reserved hues too", () => {
    const bad: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const scarf = agentColors(
        view({ id: `t${i}`, kind: "lead", teamId: `team-${i}`, displayName: "lead" }),
      ).trim;
      const parentTrim = agentColors(
        view({
          id: `u${i}`,
          kind: "subagent",
          agentType: "Explore",
          parentIdentity: `cc:parent-${i}`,
        }),
      ).trim;
      for (const c of [scarf, parentTrim]) {
        if (reserved(c)) bad.push(`${c} (hue ${Math.round(hueOf(c))})`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("still separates identities and stays stable once the bands are excluded", () => {
    const make = (i: number) => view({ id: `agent-${i}`, sourceId: "cc", sourceAgentId: `s-${i}` });
    const bodies = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const first = agentColors(make(i));
      expect(agentColors(make(i))).toEqual(first);
      bodies.add(first.body);
    }
    expect(bodies.size).toBeGreaterThanOrEqual(150);
  });
});
