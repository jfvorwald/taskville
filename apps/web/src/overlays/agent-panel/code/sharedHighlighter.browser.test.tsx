import { describe, expect, it } from "vitest";
import { sharedHighlighter } from "./highlighter.ts";

// M5.09 red round 4, item 3b: a language Shiki has no grammar for (txt, lock, no extension) is
// shown as plain lines by the shared highlighter WITHOUT fetching the Shiki chunk. Own file so the
// shared highlighter's load count starts at 0.

describe("sharedHighlighter with plain-text languages", () => {
  it.each(["txt", "lock", "text", "plaintext", ""])(
    "returns plain lines for %j without loading the backend",
    async (language) => {
      expect(sharedHighlighter.loadCount).toBe(0);
      const lines = await sharedHighlighter.highlight("a\nb", language);
      expect(lines).toEqual([[{ content: "a" }], [{ content: "b" }]]);
      expect(sharedHighlighter.loadCount).toBe(0);
    },
  );
});
