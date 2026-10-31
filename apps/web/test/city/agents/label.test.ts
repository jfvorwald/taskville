import { describe, expect, it } from "vitest";
import { agentLabel } from "../../../src/city/agents/label.ts";
import type { AgentView } from "../../../src/city/agents/types.ts";

function view(over: Partial<AgentView> = {}): AgentView {
  return {
    id: "agent-abcdef123456",
    kind: "session",
    activity: "idle",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
    ...over,
  };
}

describe("agentLabel", () => {
  it("shows the display name and the activity", () => {
    expect(agentLabel(view({ displayName: "Ada", activity: "implementing" }))).toEqual({
      name: "Ada",
      status: "Implementing",
    });
  });

  it("falls back to a short id when there is no name", () => {
    expect(agentLabel(view()).name).toBe("agent-ab");
  });

  it("maps every activity to words", () => {
    const acts = [
      ["testing", "Testing"],
      ["reviewing", "Reviewing"],
      ["researching", "Researching"],
      ["documenting", "Documenting"],
      ["dispatching", "Dispatching"],
      ["handing_off", "Handing off"],
      ["waiting", "Waiting"],
      ["idle", "Idle"],
      ["unknown", "Working"],
    ] as const;
    for (const [activity, text] of acts) {
      expect(agentLabel(view({ activity })).status).toBe(text);
    }
  });

  it("lets attention override the activity", () => {
    expect(agentLabel(view({ activity: "implementing", attention: { level: "needs_you" } })).status)
      .toBe("Needs you");
    expect(agentLabel(view({ attention: { level: "waiting" } })).status).toBe("Waiting");
  });

  it("labels heuristic trouble as such, with the selector's detail", () => {
    const label = agentLabel(
      view({ attention: { level: "trouble", detail: "quiet for 12 min", heuristic: true } }),
    );
    expect(label.status).toBe("Trouble: quiet for 12 min");
  });

  it("cleans agent-supplied names: control characters out, length capped", () => {
    expect(agentLabel(view({ displayName: "a\u0000b\nc‮d" })).name).toBe("abcd");
    const long = agentLabel(view({ displayName: "x".repeat(80) })).name;
    expect(long.length).toBeLessThanOrEqual(24);
    expect(long.endsWith("...")).toBe(true);
  });

  it("falls back to the id when the name cleans to nothing", () => {
    expect(agentLabel(view({ displayName: "\u0000 " })).name).toBe("agent-ab");
  });
});
