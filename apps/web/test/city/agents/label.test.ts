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
      ["unknown", "Unknown"],
    ] as const;
    for (const [activity, text] of acts) {
      expect(agentLabel(view({ activity })).status).toBe(text);
    }
  });

  it("lets attention override the activity", () => {
    expect(
      agentLabel(view({ activity: "implementing", attention: { level: "needs_you" } })).status,
    ).toBe("Needs you");
    expect(agentLabel(view({ attention: { level: "waiting" } })).status).toBe("Waiting");
  });

  it("keeps an unknown source state visible as Unknown, never as Working", () => {
    expect(agentLabel(view({ activity: "unknown" })).status).toBe("Unknown");
  });

  it("labels heuristic trouble as possible, with the selector's detail", () => {
    const label = agentLabel(
      view({ attention: { level: "trouble", detail: "quiet for 12 min", heuristic: true } }),
    );
    expect(label.status).toBe("Possible trouble: quiet for 12 min");
  });

  it("labels heuristic trouble without detail as plain Possible trouble", () => {
    expect(agentLabel(view({ attention: { level: "trouble", heuristic: true } })).status).toBe(
      "Possible trouble",
    );
    expect(
      agentLabel(view({ attention: { level: "trouble", detail: " \u0000 ", heuristic: true } }))
        .status,
    ).toBe("Possible trouble");
  });

  it("keeps non-heuristic trouble as Trouble", () => {
    expect(agentLabel(view({ attention: { level: "trouble" } })).status).toBe("Trouble");
    expect(
      agentLabel(view({ attention: { level: "trouble", detail: "build failed" } })).status,
    ).toBe("Trouble: build failed");
    expect(
      agentLabel(view({ attention: { level: "trouble", detail: "build failed", heuristic: false } }))
        .status,
    ).toBe("Trouble: build failed");
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

// A UTF-16 slice can cut an emoji in half and leave a lone surrogate, which renders as a
// replacement glyph (and makes `String#isWellFormed` false).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("agentLabel truncation keeps surrogate pairs whole", () => {
  it("does not split an emoji that straddles the name cap", () => {
    // NAME_MAX is 24 and the ellipsis is 3, so the cut falls after 21 code units. Put the
    // pair at code units 20 and 21 so a plain slice keeps only its high half.
    for (let pad = 17; pad <= 22; pad++) {
      const name = agentLabel(view({ displayName: `${"x".repeat(pad)}😀😀😀😀😀😀` })).name;
      expect(name, `pad ${pad}`).not.toMatch(LONE_SURROGATE);
      expect(name.length, `pad ${pad}`).toBeLessThanOrEqual(24);
    }
  });

  it("still ends in an ellipsis and keeps the leading text after a safe cut", () => {
    const name = agentLabel(view({ displayName: `${"x".repeat(20)}😀😀😀😀😀😀` })).name;
    expect(name.startsWith("x".repeat(20))).toBe(true);
    expect(name.endsWith("...")).toBe(true);
  });

  it("does not split an emoji at the short-id fallback boundary", () => {
    // ID_SHORT is 8: the pair sits at code units 7 and 8.
    const name = agentLabel(view({ id: "abcdefg😀tail" })).name;
    expect(name).not.toMatch(LONE_SURROGATE);
    expect(name.startsWith("abcdefg")).toBe(true);
  });
});
