import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { LiveTab } from "../live/LiveTab.tsx";
import { AGENT, articles, build, type CallSpec, paint, seedStore, slot } from "../live/liveKit.tsx";

// M5.24 red (#341, roborev 6660): under Hide code a grouped Read card renders a bounded number of
// names followed by "and N more", and a grouped Grep or Glob card whose hit filenames exist only
// in output evidence shows those filenames (through displayPath, bounded), never matched line
// text or the search pattern. The cap must be at most 32, the most an open group card pages at
// once; the issue example is 20, so the checks accept any cap from 1 to 32.

const TOTAL = 60;
const MAX_CAP = 32;
const pad = (n: number) => String(n).padStart(3, "0");
const readName = (n: number) => `/r/many/read-file-${pad(n)}.ts`;
const hitName = (n: number) => `/r/many/hit-file-${pad(n)}.ts`;
const LONG = `/r/${"a".repeat(1990)}/HIT_SENTINEL_LONG/${"b".repeat(1990)}/hit-long-end.ts`;
const MULTI = "/r/src/hit-multi.ts\nconst HIT_SENTINEL_MULTI = secret();";

const read = (n: number): CallSpec => ({
  id: `c-read-${n}`,
  tool: "Read",
  input: { file_path: readName(n) },
  outputRaw: "BODY_SENTINEL_READ",
  filePaths: [readName(n)],
});

/** A search whose frame records no filePaths: the hits exist only in the output evidence. */
const search = (tool: "Grep" | "Glob", n: number, filenames: string[]): CallSpec => ({
  id: `c-${tool}-${n}`,
  tool,
  input: { pattern: "PATTERN_SENTINEL" },
  output: { filenames, numFiles: filenames.length, content: "LINE_SENTINEL matched text" },
  filePaths: [],
});

async function show(specs: CallSpec[], privacy = true) {
  const { calls, evidence } = build(specs);
  await render(
    <div data-testid="agent-panel-tab-slot">
      <LiveTab
        agentId={AGENT}
        store={seedStore()}
        select={vi.fn()}
        calls={calls}
        evidence={evidence}
        privacy={privacy}
      />
    </div>,
  );
  await paint();
  await expect.poll(() => articles().elements().length).toBe(1);
  const root = slot().element();
  return { text: root.textContent ?? "", html: root.innerHTML };
}

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

describe("grouped Read card cap under privacy", () => {
  it("renders a bounded number of names then 'and N more'", async () => {
    const { text, html } = await show(Array.from({ length: TOTAL }, (_, i) => read(i + 1)));
    expect(text).toContain(`Read ${TOTAL} files`);
    const shown = count(text, /read-file-\d{3}\.ts/g);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(MAX_CAP);
    expect(text).toContain("read-file-001.ts");
    expect(text).not.toContain(`read-file-${pad(TOTAL)}.ts`);
    const more = text.match(/and (\d+) more/);
    expect(more).not.toBeNull();
    expect(Number(more?.[1])).toBe(TOTAL - shown);
    for (const out of [text, html]) expect(out).not.toContain("BODY_SENTINEL_READ");
    expect(html).not.toContain(`read-file-${pad(TOTAL)}.ts`);
  });

  it("shows every name and no 'more' indication when under the cap", async () => {
    const { text } = await show([read(1), read(2), read(3)]);
    for (const n of [1, 2, 3]) expect(text).toContain(`read-file-${pad(n)}.ts`);
    expect(text).not.toMatch(/and \d+ more/);
  });

  it("shows all names with privacy off (baseline)", async () => {
    const { text } = await show(
      Array.from({ length: TOTAL }, (_, i) => read(i + 1)),
      false,
    );
    expect(text).toContain(`Read ${TOTAL} files`);
    expect(text).not.toContain("BODY_SENTINEL_READ");
  });
});

describe.each(["Grep", "Glob"] as const)("grouped %s card hit names under privacy", (tool) => {
  it("shows bounded hit filenames from output evidence, no line text, no pattern", async () => {
    const { text, html } = await show([
      search(tool, 1, [hitName(1), LONG]),
      search(tool, 2, [MULTI, hitName(2)]),
    ]);
    expect(text).toContain("Searched 2 times");
    expect(text).toContain("hit-file-001.ts");
    expect(text).toContain("hit-file-002.ts");
    expect(text).toContain("hit-long-end.ts");
    expect(text).toContain("path hidden");
    for (const out of [text, html]) {
      expect(out).not.toContain("LINE_SENTINEL");
      expect(out).not.toContain("PATTERN_SENTINEL");
      expect(out).not.toContain(LONG);
      expect(out).not.toContain("HIT_SENTINEL_LONG");
      expect(out).not.toContain("HIT_SENTINEL_MULTI");
      expect(out).not.toContain("secret()");
    }
  });

  it("caps many hit filenames and says 'and N more'", async () => {
    const names = Array.from({ length: TOTAL }, (_, i) => hitName(i + 1));
    const { text, html } = await show([
      search(tool, 1, names.slice(0, TOTAL / 2)),
      search(tool, 2, names.slice(TOTAL / 2)),
    ]);
    const shown = count(text, /hit-file-\d{3}\.ts/g);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(MAX_CAP);
    expect(text).not.toContain(`hit-file-${pad(TOTAL)}.ts`);
    expect(html).not.toContain(`hit-file-${pad(TOTAL)}.ts`);
    const more = text.match(/and (\d+) more/);
    expect(more).not.toBeNull();
    expect(Number(more?.[1])).toBe(TOTAL - shown);
    for (const out of [text, html]) {
      expect(out).not.toContain("LINE_SENTINEL");
      expect(out).not.toContain("PATTERN_SENTINEL");
    }
  });

  it("keeps the group heading and no line text with privacy off (baseline)", async () => {
    const { text } = await show(
      [search(tool, 1, [hitName(1)]), search(tool, 2, [hitName(2)])],
      false,
    );
    expect(text).toContain("Searched 2 times");
    expect(text).not.toContain("LINE_SENTINEL");
  });
});
