import { describe, expect, it } from "vitest";
import { fileScreenLabel } from "./label.ts";

// M5.09 red: the floating screen above the selected agent's workstation shows the current file
// name only. It is plain text (a canvas or sprite label), bounded, and never a path outside the
// base name, so a long or hostile path cannot spoof or flood the scene.

describe("fileScreenLabel", () => {
  it("shows the base name of a path", () => {
    expect(fileScreenLabel("/Users/me/app/src/city/path.ts")).toBe("path.ts");
    expect(fileScreenLabel("C:\\work\\app\\main.rs")).toBe("main.rs");
  });

  it("shows a quiet placeholder when there is no current file", () => {
    expect(fileScreenLabel(null)).toBe("no file");
    expect(fileScreenLabel(undefined)).toBe("no file");
    expect(fileScreenLabel("")).toBe("no file");
    expect(fileScreenLabel("/a/b/")).toBe("no file");
  });

  it("makes hidden and reordering characters visible and keeps the label short", () => {
    const rlo = String.fromCodePoint(0x202e);
    expect(fileScreenLabel(`/a/evil${rlo}gnp.exe`)).toBe("evil<U+202E>gnp.exe");
    const long = fileScreenLabel(`/a/${"x".repeat(200)}.ts`);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith(".ts") || long.endsWith("\u2026")).toBe(true);
  });

  it("is plain text: markup stays literal", () => {
    expect(fileScreenLabel("/a/<b>x</b>.ts")).toBe("<b>x</b>.ts");
  });
});
