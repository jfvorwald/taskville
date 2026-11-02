import { describe, expect, it } from "vitest";
import { fakeBackend, lazyHighlighterParts } from "./codeKit.tsx";
import { createCodeHighlighter } from "./highlighter.ts";

// M5.09 red: Shiki loads lazily, once, on the first highlight (the first expand).

describe("createCodeHighlighter", () => {
  it("does not load the backend when created", () => {
    const { backend } = fakeBackend();
    const { load } = lazyHighlighterParts(backend);
    const highlighter = createCodeHighlighter(load);
    expect(load).not.toHaveBeenCalled();
    expect(highlighter.loadCount).toBe(0);
  });

  it("loads once on first use and reuses it, even for concurrent calls", async () => {
    const { backend, calls } = fakeBackend();
    const { load } = lazyHighlighterParts(backend);
    const highlighter = createCodeHighlighter(load);
    const [a, b] = await Promise.all([
      highlighter.highlight("one\ntwo", "ts"),
      highlighter.highlight("three", "python"),
    ]);
    await highlighter.highlight("four", "ts");
    expect(load).toHaveBeenCalledTimes(1);
    expect(highlighter.loadCount).toBe(1);
    expect(a).toEqual([[{ content: "one" }], [{ content: "two" }]]);
    expect(b).toEqual([[{ content: "three" }]]);
    expect(calls.map((c) => c.language)).toEqual(["ts", "python", "ts"]);
  });

  it("falls back to plain lines when the backend fails to load, and retries later", async () => {
    let attempts = 0;
    const { backend } = fakeBackend();
    const highlighter = createCodeHighlighter(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk failed");
      return backend;
    });
    expect(await highlighter.highlight("a\nb", "ts")).toEqual([
      [{ content: "a" }],
      [{ content: "b" }],
    ]);
    expect(await highlighter.highlight("a", "ts")).toEqual([[{ content: "a" }]]);
    expect(attempts).toBe(2);
  });

  it("falls back to plain lines when tokenizing throws (unknown language)", async () => {
    const highlighter = createCodeHighlighter(async () => ({
      tokenize: async () => {
        throw new Error("unknown language");
      },
    }));
    expect(await highlighter.highlight("x\ny", "klingon")).toEqual([
      [{ content: "x" }],
      [{ content: "y" }],
    ]);
  });
});
