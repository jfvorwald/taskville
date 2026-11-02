import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { LiveTab } from "../live/LiveTab.tsx";
import { AGENT, articles, build, paint, seedStore, slot } from "../live/liveKit.tsx";

// M5.23 red (issue #338): under Hide code the hidden tool card must not carry content in a
// recorded path. A multi-line path is replaced by "path hidden"; a 4,000 character path is
// bounded. Neither the sentinel nor the full long path may be in the text or the innerHTML
// (which also covers title, aria-label and href).

const MULTI = "/r/src/a.ts\nconst PATH_SENTINEL_LIVE = secret();\nexport {};";
const LONG = `/r/${"a".repeat(1990)}/PATH_SENTINEL_LONG/${"b".repeat(1990)}/end.ts`;

async function show(privacy: boolean, path: string) {
  const { calls, evidence } = build([{ id: "p1", tool: "Edit", filePaths: [path] }]);
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

describe("Live hidden card paths under privacy", () => {
  it("shows the path as recorded with privacy off (baseline)", async () => {
    const { text } = await show(false, "/r/src/a.ts");
    expect(text).toContain("/r/src/a.ts");
  });

  it("hides a multi-line path", async () => {
    const { text, html } = await show(true, MULTI);
    expect(text).toContain("path hidden");
    for (const out of [text, html]) {
      expect(out).not.toContain("PATH_SENTINEL_LIVE");
      expect(out).not.toContain("secret()");
    }
  });

  it("bounds a 4,000 character path", async () => {
    const { text, html } = await show(true, LONG);
    for (const out of [text, html]) {
      expect(out).not.toContain(LONG);
      expect(out).not.toContain("PATH_SENTINEL_LONG");
      expect(out.length).toBeLessThan(1500);
    }
  });
});
