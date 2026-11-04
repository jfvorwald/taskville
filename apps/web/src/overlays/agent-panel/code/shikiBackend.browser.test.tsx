import { describe, expect, it } from "vitest";
import { createShikiBackend } from "./shikiBackend.ts";

// M5.09 red round 4, item 3a: the real Shiki backend (JavaScript regex engine) returns coloured tokens.

describe("createShikiBackend", () => {
  it("tokenizes TypeScript with hex colours and keeps the text intact", async () => {
    const backend = await createShikiBackend();
    const lines = await backend.tokenize("const a = 1", "ts");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.map((t) => t.content).join("")).toBe("const a = 1");
    const colours = (lines[0] ?? []).map((t) => t.color);
    expect(colours.some((c) => c !== undefined && /^#[0-9a-f]{6,8}$/i.test(c))).toBe(true);
  });

  it("rejects an unknown language so the highlighter can fall back", async () => {
    const backend = await createShikiBackend();
    await expect(backend.tokenize("x", "not-a-language")).rejects.toThrow();
  });
});
