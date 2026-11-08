import { describe, expect, it } from "vitest";
import { parseInputEvent } from "../src/index.ts";
import { validPayloads, wireEvent } from "./fixtures.ts";

// M8.01: git.commit gains an optional, additive `files` counts field for changed-file summaries.

const commit = (payload: Record<string, unknown>) =>
  parseInputEvent(wireEvent("git.commit", payload, { provenance: "imported" }));

describe("git.commit files counts", () => {
  it("parses with files counts", () => {
    const result = commit({
      ...validPayloads["git.commit"],
      files: { added: 1, modified: 2, deleted: 3, renamed: 4 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.event.payload as Record<string, unknown>).files).toEqual({
        added: 1,
        modified: 2,
        deleted: 3,
        renamed: 4,
      });
    }
  });

  it("still parses without files", () => {
    expect(commit({ ...validPayloads["git.commit"] }).ok).toBe(true);
  });

  it("rejects negative or missing counts and unknown keys", () => {
    const bad = [
      { added: -1, modified: 0, deleted: 0, renamed: 0 },
      { added: 1, modified: 0, deleted: 0 },
      { added: 1, modified: 0, deleted: 0, renamed: 0, extra: 1 },
    ];
    for (const files of bad) {
      const result = commit({ ...validPayloads["git.commit"], files });
      expect(result.ok).toBe(false);
    }
  });
});
