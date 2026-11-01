import { describe, expect, it } from "vitest";
import { inputText } from "../../../src/overlays/action-card/input.ts";

// M4.07: the text the card shows for a held request's `toolInput` (any JSON). It is the exact
// input, never summarized or cut: a string as it is, a Bash-style `{ command }` as the command
// itself (so a multi-line script reads as a script, not as `\n` escapes), anything else as
// two-space pretty JSON.

describe("inputText", () => {
  it("returns a string input unchanged", () => {
    expect(inputText("rm -rf build\necho done")).toBe("rm -rf build\necho done");
  });

  it("returns the command of an object whose only key is `command`, with its newlines", () => {
    expect(inputText({ command: "set -e\nmake all\n" })).toBe("set -e\nmake all\n");
  });

  it("pretty-prints an object with other keys, so nothing the agent sent is hidden", () => {
    const input = { command: "ls", run_in_background: true, timeout: 5000 };
    expect(inputText(input)).toBe(JSON.stringify(input, null, 2));
  });

  it("pretty-prints other tools' inputs", () => {
    const input = { file_path: "/work/app/.env", old_string: "a", new_string: "b" };
    expect(inputText(input)).toBe(JSON.stringify(input, null, 2));
  });

  it("does not cut a very long input", () => {
    const long = "x".repeat(50_000);
    expect(inputText(long)).toHaveLength(50_000);
    expect(inputText({ command: long })).toHaveLength(50_000);
  });

  it("renders null, numbers and a missing input as JSON text instead of throwing", () => {
    expect(inputText(null)).toBe("null");
    expect(inputText(undefined)).toBe("null");
    expect(inputText(42)).toBe("42");
  });

  it("keeps markup as plain characters (escaping is the renderer's job)", () => {
    expect(inputText("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
});
