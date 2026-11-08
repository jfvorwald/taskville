import { describe, expect, it } from "vitest";
import { createTranscriptMapper } from "../../../src/claude-code/transcripts/index.ts";
import { assistantToolUse, fakeApiKey, T, toolResult } from "./fixtures.ts";

// A secret that straddles an evidence cut point must not leak in any form (M8.02 review fix).
// Lead decision: pre-cut strings at 64 KiB, redact, then the final 8 KiB cut, so a secret that
// straddles the 8 KiB boundary is masked whole before the cut instead of being cut in half and
// left partly recognizable. A secret straddling the 64 KiB pre-cut is discarded by the 8 KiB cut.

const KIB = 1024;

function evidenceFor(output: unknown): string {
  const mapper = createTranscriptMapper({ projectId: "proj-1" });
  mapper.mapLine(
    JSON.stringify(assistantToolUse("toolu_C", "Bash", { command: "cat" }, { ts: T(0) })),
    1,
  );
  const r = mapper.mapLine(JSON.stringify(toolResult("toolu_C", output, { ts: T(1) })), 2);
  return JSON.stringify(r.evidence ?? []);
}

/** `key` starts `before` characters ahead of `boundary`, so that many of its characters would
 * survive a cut at `boundary`. */
const straddling = (key: string, boundary: number, before: number): string =>
  `${"p".repeat(boundary - before)}${key}${"q".repeat(boundary)}`;

describe("a secret straddling the evidence cut", () => {
  const key = fakeApiKey();

  it("does not survive in any form when it starts just before the 8 KiB boundary", () => {
    for (const before of [3, 14, 20]) {
      const text = evidenceFor(straddling(key, 8 * KIB, before));
      expect(text, `before=${before}`).not.toContain(key);
      expect(text, `before=${before}`).not.toContain(key.slice(0, 12));
      expect(text, `before=${before}`).not.toContain(key.slice(0, 8));
    }
  });

  it("does not survive when the output is a list of text blocks", () => {
    const text = evidenceFor([{ type: "text", text: straddling(key, 8 * KIB, 14) }]);
    expect(text).not.toContain(key.slice(0, 12));
  });

  it("does not survive when it starts just before the 64 KiB pre-cut boundary", () => {
    for (const before of [3, 14, 20]) {
      const text = evidenceFor(straddling(key, 64 * KIB, before));
      expect(text, `before=${before}`).not.toContain(key.slice(0, 12));
      expect(text, `before=${before}`).not.toContain(key.slice(0, 8));
    }
  });

  it("still keeps evidence at most 64 KiB", () => {
    expect(Buffer.byteLength(evidenceFor(straddling(key, 8 * KIB, 14)))).toBeLessThanOrEqual(
      64 * KIB,
    );
  });
});
