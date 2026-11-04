import { describe, expect, it } from "vitest";
import { fakeBackend, lazyHighlighterParts } from "./codeKit.tsx";
import { createCodeHighlighter } from "./highlighter.ts";

// M5.09 red round 4, item 4: minified or generated lines would stall the tokenizer, so a body with
// any line over 2000 characters is returned as plain lines and never tokenized.

function setup() {
  const fake = fakeBackend(() => [[{ content: "TOKENIZED", color: "#ff0000" }]]);
  const { load } = lazyHighlighterParts(fake.backend);
  return { ...fake, highlighter: createCodeHighlighter(load) };
}

describe("highlight line-length limit", () => {
  it("returns plain lines and skips the tokenizer when a line is over 2000 characters", async () => {
    const { highlighter, calls } = setup();
    const long = "x".repeat(2001);
    const lines = await highlighter.highlight(`short\n${long}\nend`, "ts");
    expect(lines).toEqual([[{ content: "short" }], [{ content: long }], [{ content: "end" }]]);
    expect(calls).toHaveLength(0);
  });

  it("still highlights a line of exactly 2000 characters", async () => {
    const { highlighter, calls } = setup();
    const lines = await highlighter.highlight("y".repeat(2000), "ts");
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([[{ content: "TOKENIZED", color: "#ff0000" }]]);
  });
});
