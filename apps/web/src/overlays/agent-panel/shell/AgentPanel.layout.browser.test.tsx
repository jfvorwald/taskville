import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createDataStore } from "../../../data/store.ts";
import "../../../styles/tokens.css";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "./AgentPanel.tsx";

// M10.03 red: panel shell layout (design 2026-11-08-agent-panel-readability, Layout and Tokens).
// The panel is min(440px, 100% - 32px) wide and fills its slot's height; the header (name, status)
// and the tab list stay in view while only the tab slot scrolls; new tokens exist on :root.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const SLOT_HEIGHT = 700;
const iso = (ms: number) => new Date(NOW + ms).toISOString();

const store = (() => {
  const s = createDataStore({ now: () => NOW });
  s.setState({
    projectId: "proj-1",
    connection: "live",
    attention: [],
    state: {
      agents: {
        L: {
          id: "L",
          sourceId: "claude-code",
          kind: "lead",
          displayName: "Lead",
          registered: true,
          registeredSeq: 1,
          connection: "connected",
          firstSeenAt: iso(-60_000),
          lastSeenAt: iso(0),
          toolCallCount: 0,
          consecutiveToolFailures: 0,
        },
      },
      teams: {},
      activity: { L: { agentId: "L", activity: "testing", heuristic: false, since: iso(-1000) } },
      toolCalls: {},
    } as unknown as NonNullable<ReturnType<typeof s.getState>["state"]>,
  });
  return s;
})();

const props: OverlayProps = {
  mode: "live",
  selectors: {
    counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
  },
  selection: { selectedId: "L", select: () => {} },
  anchors: createAnchorSource(),
  intents: { available: true, run: () => {} },
  settings: { get: (_k, f) => f, set: () => {} },
};

const tall = (rows: number) => (
  <div data-testid="feed" style={{ height: rows * 40 }}>
    feed
  </div>
);

/** The panel sits in a slot of known size, like the sidebar slot of the overlay host. */
async function mount(content: () => React.ReactNode) {
  return render(
    <div
      style={{ position: "relative", width: "100%", height: SLOT_HEIGHT }}
      data-testid="slot-frame"
    >
      <AgentPanel {...props} store={store} renderTab={content} />
    </div>,
  );
}

const panelEl = () => page.getByTestId("agent-panel").element() as HTMLElement;
const slotEl = () => page.getByTestId("agent-panel-tab-slot").element() as HTMLElement;
const inside = (inner: DOMRect, outer: DOMRect) =>
  inner.top >= outer.top - 1 &&
  inner.bottom <= outer.bottom + 1 &&
  inner.height > 0 &&
  inner.left >= outer.left - 1 &&
  inner.right <= outer.right + 1;

const original = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  await page.viewport(original.width, original.height);
});

describe("agent panel scrolling", () => {
  it("keeps the header and the tab list in view while only the tab slot scrolls", async () => {
    await mount(() => tall(60));
    const panel = panelEl();
    const slot = slotEl();
    // A user wheel over the feed scrolls whatever scrolls; try the slot, then the panel.
    slot.scrollTop = 800;
    panel.scrollTop = 800;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(slot.scrollTop, "the tab slot scrolls its own content").toBeGreaterThan(0);
    expect(panel.scrollTop, "the panel itself does not scroll").toBe(0);
    const box = panel.getBoundingClientRect();
    for (const el of [
      page.getByTestId("agent-panel-name").element(),
      page.getByTestId("agent-panel-status").element(),
      page.getByRole("tablist").element(),
    ]) {
      expect(inside(el.getBoundingClientRect(), box)).toBe(true);
    }
  });
});

describe("agent panel size", () => {
  it("is about 440 px wide at a 1440 px viewport", async () => {
    await page.viewport(1440, 900);
    await mount(() => tall(2));
    expect(panelEl().getBoundingClientRect().width).toBeGreaterThanOrEqual(436);
    expect(panelEl().getBoundingClientRect().width).toBeLessThanOrEqual(444);
  });

  it("is never wider than the viewport minus 32 px at a narrow viewport", async () => {
    await page.viewport(400, 800);
    await mount(() => tall(2));
    const width = panelEl().getBoundingClientRect().width;
    expect(width).toBeLessThanOrEqual(400 - 32 + 1);
    expect(width).toBeGreaterThan(300);
  });

  // Lead decision (M10.03 review): the panel is as tall as its content, capped at the slot, so
  // a short panel never covers what lies below it (the history strip, other controls).
  it("fits short content and never grows past its slot", async () => {
    await page.viewport(1440, 900);
    await mount(() => tall(1));
    const frame = page.getByTestId("slot-frame").element().getBoundingClientRect();
    const short = panelEl().getBoundingClientRect();
    expect(short.height).toBeLessThan(frame.height - 40);
    expect(short.bottom).toBeLessThanOrEqual(frame.bottom + 1);
  });

  it("caps tall content at the slot height and scrolls inside the tab slot", async () => {
    await page.viewport(1440, 900);
    await mount(() => tall(80));
    const frame = page.getByTestId("slot-frame").element().getBoundingClientRect();
    const box = panelEl().getBoundingClientRect();
    expect(box.height).toBeGreaterThanOrEqual(frame.height - 40);
    expect(box.bottom).toBeLessThanOrEqual(frame.bottom + 1);
  });
});

describe("new design tokens", () => {
  const read = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  it("defines --tv-ok, --tv-fail and --tv-running on :root", () => {
    expect(read("--tv-ok")).toBe("#5fb98a");
    expect(read("--tv-fail")).toBe("#e0605a");
    expect(read("--tv-running")).not.toBe("");
    expect(read("--tv-running")).toBe(read("--tv-accent"));
  });

  it("defines --tv-mono as a monospace stack and --tv-rule as a color", () => {
    expect(read("--tv-mono")).toContain("monospace");
    expect(read("--tv-rule")).not.toBe("");
  });
});
