import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { LiveTab } from "../live/LiveTab.tsx";
import { AGENT, articles, build, type CallSpec, paint, seedStore, slot } from "../live/liveKit.tsx";

// M5.23 red round 2 (roborev 6653, LiveTab.tsx:576; ARCHITECTURE 2.10): under Hide code a grouped
// Read or Search card keeps its count and the recorded file names, each through displayPath (a
// long name is bounded, a multi-line name is "path hidden"), and shows no evidence body.

const LONG = `/r/${"a".repeat(1990)}/PATH_SENTINEL_LONG/${"b".repeat(1990)}/long-end.ts`;
const MULTI = "/r/src/multi.ts\nconst PATH_SENTINEL_MULTI = secret();";

const read = (n: number, path: string, extra: Partial<CallSpec> = {}): CallSpec => ({
  id: `g-read-${n}`,
  tool: "Read",
  input: { file_path: path },
  outputRaw: "BODY_SENTINEL_READ",
  filePaths: [path],
  ...extra,
});
const grep = (n: number, path: string): CallSpec => ({
  id: `g-grep-${n}`,
  tool: "Grep",
  input: { pattern: "PATTERN_SENTINEL" },
  outputRaw: "BODY_SENTINEL_GREP",
  filePaths: [path],
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

describe("grouped Read card under privacy", () => {
  it("keeps the count and the file names, and no body", async () => {
    const { text, html } = await show([
      read(1, "/r/src/first-file.ts"),
      read(2, "/r/src/second-file.ts"),
      read(3, "/r/src/third-file.ts"),
    ]);
    expect(text).toContain("Read 3 files");
    for (const name of ["first-file.ts", "second-file.ts", "third-file.ts"])
      expect(text).toContain(name);
    for (const out of [text, html]) expect(out).not.toContain("BODY_SENTINEL_READ");
  });

  it("bounds a long name and hides a multi-line name", async () => {
    const { text, html } = await show([
      read(1, LONG),
      read(2, MULTI),
      read(3, "/r/src/plain-file.ts"),
    ]);
    expect(text).toContain("Read 3 files");
    expect(text).toContain("long-end.ts");
    expect(text).toContain("path hidden");
    expect(text).toContain("plain-file.ts");
    for (const out of [text, html]) {
      expect(out).not.toContain(LONG);
      expect(out).not.toContain("PATH_SENTINEL_LONG");
      expect(out).not.toContain("PATH_SENTINEL_MULTI");
      expect(out).not.toContain("secret()");
    }
  });

  it("shows everything as before with privacy off (baseline)", async () => {
    const { text } = await show([read(1, "/r/src/first-file.ts"), read(2, "/r/src/b.ts")], false);
    expect(text).toContain("Read 2 files");
  });
});

describe("grouped Search card under privacy", () => {
  it("keeps the count and bounded file names, no pattern and no body", async () => {
    const { text, html } = await show([
      grep(1, "/r/src/hit-one.ts"),
      grep(2, LONG),
      grep(3, MULTI),
    ]);
    expect(text).toContain("Searched 3 times");
    expect(text).toContain("hit-one.ts");
    expect(text).toContain("long-end.ts");
    expect(text).toContain("path hidden");
    for (const out of [text, html]) {
      expect(out).not.toContain("BODY_SENTINEL_GREP");
      expect(out).not.toContain("PATTERN_SENTINEL");
      expect(out).not.toContain(LONG);
      expect(out).not.toContain("PATH_SENTINEL_LONG");
      expect(out).not.toContain("PATH_SENTINEL_MULTI");
    }
  });
});
