import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mermaidBlocks, validateMermaid } from "../src/mermaid.ts";
import { renderRetro } from "../src/render.ts";
import { example, NOW } from "./example-snapshot.ts";

const template = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "docs", "retros", "TEMPLATE.md"),
  "utf8",
);

describe("renderRetro", () => {
  const md = renderRetro({ snapshot: example, template, now: NOW, key: "M9" });

  it("fills every placeholder", () => {
    expect(md).not.toMatch(/\{\{|\}\}|undefined|NaN|null/);
    expect(md).toContain("# Retro: M9 Example");
    expect(md).toContain("by `pnpm retro M9`");
    expect(md).toContain("Generated 2026-01-03T12:00Z");
  });

  it("produces Mermaid that validates", () => {
    const blocks = mermaidBlocks(md);
    expect(blocks).toHaveLength(5);
    for (const block of blocks) expect(validateMermaid(block.source)).toEqual([]);
  });

  it("shows the at-a-glance row", () => {
    expect(md).toContain("| 4 | 1 | 2 | 1 | 3 | 2 | 50% | 1 | 1 |");
  });

  it("draws the Gantt by lane, with in-progress tickets ending now", () => {
    expect(md).toContain(
      "  section Domain\n  M9.02 Beta domain work :done, 2026-01-02T10:00, 2026-01-03T10:00\n  M9.03 Gamma :active, 2026-01-03T08:00, 2026-01-03T12:00\n",
    );
    expect(md).toContain(
      "  section Infra\n  M9.01 Alpha tooling :done, 2026-01-01T10:00, 2026-01-02T12:00\n",
    );
    expect(md).toContain("Not started: M9.05.");
  });

  it("notes the most tickets in progress at one moment under the parallelism chart", () => {
    expect(md).toContain("Most in progress at one moment: 2 (2026-01-02T10:00 UTC).");
  });

  it("prints not measured instead of estimating", () => {
    expect(md).toContain("Not measured: L (no merged L tickets).");
    expect(md).toContain("not measured / not measured / not measured");
    expect(md).toMatch(/\| Split \| not measured \|/);
  });

  it("states the definitions the numbers rest on", () => {
    expect(md).toContain("UTC");
  });

  it("lists plan versus actual", () => {
    expect(md).toContain("| Planned | 4 | M9.01, M9.02, M9.03, M9.04 |");
    expect(md).toContain("| Added mid-milestone | 1 | M9.05 |");
    expect(md).toContain("| Dropped | 1 | M9.04 |");
    expect(md).toContain("| Still open | 2 | M9.03, M9.05 |");
  });

  it("keeps the lead's written sections on re-run", () => {
    const edited = md.replace(
      "## What went well *(written)*\n",
      "## What went well *(written)*\n\nLanes ran in parallel.\n",
    );
    const again = renderRetro({
      snapshot: example,
      template,
      now: NOW,
      key: "M9",
      existing: edited,
    });
    expect(again).toContain("## What went well *(written)*\n\nLanes ran in parallel.\n");
  });
});
