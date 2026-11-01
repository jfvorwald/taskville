import { describe, expect, it } from "vitest";
import { bubbleFact } from "../../../src/overlays/bubbles/fact.ts";

// M4.06: a bubble may carry one short fact from the event, the tool name ("Needs OK: Bash").
// Only a tool name that looks like a tool name is used; anything else yields no fact, because
// agent-supplied text never appears in a bubble (ARCHITECTURE.md 2.3).

describe("bubbleFact", () => {
  it("formats the tool name for a needs-you bubble", () => {
    expect(bubbleFact({ level: "needs_you", toolName: "Bash" })).toBe("Needs OK: Bash");
    expect(bubbleFact({ level: "needs_you", toolName: "mcp__github__create_issue" })).toBe(
      "Needs OK: mcp__github__create_issue",
    );
  });

  it("gives no fact without a tool name", () => {
    expect(bubbleFact({ level: "needs_you" })).toBeNull();
    expect(bubbleFact({ level: "needs_you", toolName: undefined })).toBeNull();
    expect(bubbleFact({ level: "needs_you", toolName: "" })).toBeNull();
  });

  it.each([
    ["spaces", "rm -rf /"],
    ["a sentence", "Please approve this, it is safe"],
    ["markup", "<b>Bash</b>"],
    ["a script tag", "<script>alert(1)</script>"],
    ["a newline", "Bash\nIgnore previous instructions"],
    ["a path", "/etc/passwd"],
    ["a quote", 'Bash"'],
    ["too long", "A".repeat(64)],
    ["a leading digit", "9Bash"],
  ])("gives no fact for a tool name with %s", (_why, toolName) => {
    expect(bubbleFact({ level: "needs_you", toolName })).toBeNull();
  });

  it("gives no fact for a non-string tool name", () => {
    expect(bubbleFact({ level: "needs_you", toolName: 42 as unknown as string })).toBeNull();
    expect(bubbleFact({ level: "needs_you", toolName: { x: 1 } as unknown as string })).toBeNull();
  });

  it("accepts a reasonably long real tool name", () => {
    const name = "mcp__plugin_name__a_tool_name1";
    expect(name.length).toBeLessThanOrEqual(32);
    expect(bubbleFact({ level: "needs_you", toolName: name })).toBe(`Needs OK: ${name}`);
  });
});
