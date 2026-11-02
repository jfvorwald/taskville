import { describe, expect, it } from "vitest";
import { displayPath } from "./displayPath.ts";

// M5.23 red (issue #338): one shared rule for showing a recorded path.
//
// Interface:
//   displayPath(path: string, { privacy }: { privacy: boolean }): string
// Privacy off: the path unchanged. Privacy on: the path if it has no newline or control/format
// character (bidi included) and is at most about 200 characters; a longer one is middle-truncated
// to at most about 200; anything with a newline or control character is the text "path hidden".

const HIDDEN = "path hidden";
const on = { privacy: true };
const off = { privacy: false };

describe("displayPath", () => {
  it("shows a normal path under privacy", () => {
    expect(displayPath("/Users/me/app/src/a.ts", on)).toBe("/Users/me/app/src/a.ts");
  });

  it("middle-truncates a 4,000 character path to about 200 characters", () => {
    const path = `/r/${"a".repeat(1990)}/MIDDLE_SENTINEL/${"b".repeat(1990)}/end.ts`;
    expect(path.length).toBeGreaterThan(3900);
    const shown = displayPath(path, on);
    expect(shown.length).toBeLessThanOrEqual(210);
    expect(shown.length).toBeGreaterThan(20);
    expect(shown).not.toBe(HIDDEN);
    expect(shown.startsWith("/r/")).toBe(true);
    expect(shown.endsWith("/end.ts")).toBe(true);
    expect(shown).not.toContain("MIDDLE_SENTINEL");
  });

  it("hides a multi-line path", () => {
    expect(displayPath("/r/a.ts\nconst SENTINEL = 1;", on)).toBe(HIDDEN);
    expect(displayPath("/r/a.ts\r\nrm -rf /", on)).toBe(HIDDEN);
    expect(displayPath("/r/a.ts x", on)).toBe(HIDDEN);
  });

  it("hides a path with a control or bidi character", () => {
    for (const bad of ["\u0000", "\u0007", "\u001b[31m", "\u007f", "‮", "⁦", "‏"])
      expect(displayPath(`/r/a${bad}b.ts`, on), JSON.stringify(bad)).toBe(HIDDEN);
  });

  it("leaves every path unchanged with privacy off", () => {
    const long = `/r/${"a".repeat(3990)}/end.ts`;
    for (const path of ["/r/a.ts", "/r/a.ts\nSENTINEL", "/r/a‮b.ts", long])
      expect(displayPath(path, off)).toBe(path);
  });
});
