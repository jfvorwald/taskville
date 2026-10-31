import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mermaidBlocks, validateMermaid } from "../src/mermaid.ts";
import { renderRetro } from "../src/render.ts";
import type { Snapshot } from "../src/types.ts";

// Golden test: the M1 GitHub data recorded with `pnpm retro M1 --record` (redacted: the snapshot
// keeps no logins, names, or emails) must render exactly the reviewed golden report. To accept an
// intended change, run with RETRO_UPDATE_GOLDEN=1 and review the diff of m1-golden.md.
const dir = join(import.meta.dirname, "fixtures");
const snapshot = JSON.parse(readFileSync(join(dir, "m1-snapshot.json"), "utf8")) as Snapshot & {
  recordedAt: string;
};
const template = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "docs", "retros", "TEMPLATE.md"),
  "utf8",
);
const goldenPath = join(dir, "m1-golden.md");

describe("M1 golden report", () => {
  const md = renderRetro({ snapshot, template, now: new Date(snapshot.recordedAt), key: "M1" });
  if (process.env.RETRO_UPDATE_GOLDEN === "1") writeFileSync(goldenPath, md);

  it("matches the reviewed golden report", () => {
    expect(md).toBe(readFileSync(goldenPath, "utf8"));
  });

  it("has only Mermaid blocks that validate", () => {
    const blocks = mermaidBlocks(md);
    expect(blocks).toHaveLength(5);
    for (const block of blocks)
      expect(validateMermaid(block.source), `line ${block.line}`).toEqual([]);
  });

  it("keeps no personal data in the recorded snapshot", () => {
    const raw = readFileSync(join(dir, "m1-snapshot.json"), "utf8");
    // No API user fields, no email addresses, no owner login, no real home paths.
    expect(raw).not.toMatch(/"(login|email|avatar_url|name)":/);
    expect(raw).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(raw).not.toMatch(/jfvorwald/i);
    expect(raw).not.toMatch(/\/Users\/(?!dev\b)[A-Za-z]/);
  });
});
