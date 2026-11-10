import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createDataStore } from "../../data/store.ts";
import "../../styles/tokens.css";
import { AGENT_PANEL_ID, AgentPanel } from "../agent-panel/shell/AgentPanel.tsx";
import { createAnchorSource } from "./anchors.ts";
import { InteractiveRegion } from "./InteractiveRegion.tsx";
import { OverlayHost, type OverlayHostProps } from "./OverlayHost.tsx";
import { createOverlayRegistry } from "./registry.ts";
import type { OverlayDefinition, OverlayProps } from "./types.ts";

// M10.03 review-fix red: the agent panel inside the real OverlayHost. At a short viewport the tab
// list stays reachable and the tab slot keeps room (or the panel scrolls); the wider sidebar slot
// belongs to the agent panel only, so the action card keeps its previous 360 px width.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const mk = (id: string, over: Record<string, unknown>) => ({
  id,
  sourceId: "claude-code",
  registered: true,
  connection: "connected",
  firstSeenAt: iso(-60_000),
  lastSeenAt: iso(0),
  toolCallCount: 0,
  consecutiveToolFailures: 0,
  ...over,
});
const FILE = "/work/project/src/components/deeply/nested/folders/for/the/test/FileName.tsx";

const store = (() => {
  const s = createDataStore({ now: () => NOW });
  s.setState({
    projectId: "proj-1",
    connection: "live",
    attention: [],
    state: {
      agents: {
        L: mk("L", { kind: "lead", displayName: "Lead", registeredSeq: 1 }),
        c: mk("c", {
          kind: "subagent",
          parentAgentId: "L",
          displayName: "A reviewer with a rather long display name",
          role: "explorer",
          registeredSeq: 2,
        }),
      },
      teams: {},
      activity: { c: { agentId: "c", activity: "testing", heuristic: false, since: iso(-1000) } },
      toolCalls: {
        k1: { agentId: "c", phase: "running", startSeq: 1, filePaths: [FILE] },
      },
    } as unknown as NonNullable<ReturnType<typeof s.getState>["state"]>,
  });
  return s;
})();

function StoreAgentPanel(props: OverlayProps) {
  return <AgentPanel {...props} store={store} />;
}
const agentPanel: OverlayDefinition = {
  id: AGENT_PANEL_ID,
  slot: "sidebar",
  modes: ["live", "history"],
  Component: StoreAgentPanel,
};
const actionCard: OverlayDefinition = {
  id: "action-card",
  slot: "sidebar",
  modes: ["live", "history"],
  Component: () => <InteractiveRegion data-testid="card">card</InteractiveRegion>,
};

function host(enabled: string[], selectedId: string | null): OverlayHostProps {
  return {
    registry: createOverlayRegistry([agentPanel, actionCard]),
    mode: "live",
    enabled,
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select: () => {} },
    anchors: createAnchorSource(),
    runIntent: () => {},
    storage: null,
  };
}

const original = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  await page.viewport(original.width, original.height);
});

const el = (testId: string) => page.getByTestId(testId).element() as HTMLElement;

describe("agent panel in the overlay host", () => {
  it("keeps the tab list visible and room in the tab slot at a 900x400 viewport", async () => {
    await page.viewport(900, 400);
    await render(<OverlayHost {...host([AGENT_PANEL_ID], "c")} />);
    const panel = el("agent-panel");
    const slot = el("agent-panel-tab-slot");
    const tabs = page.getByRole("tablist").element().getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    expect(tabs.top).toBeGreaterThanOrEqual(box.top - 1);
    expect(tabs.bottom).toBeLessThanOrEqual(Math.min(box.bottom, 400) + 1);
    const overflowY = getComputedStyle(panel).overflowY;
    const panelScrolls =
      panel.scrollHeight > panel.clientHeight + 1 &&
      (overflowY === "auto" || overflowY === "scroll");
    // Lead decision: the slot keeps about 120 px, or the panel scrolls as the fallback.
    expect(slot.getBoundingClientRect().height >= 118 || panelScrolls).toBe(true);
    // Whatever is clipped must be reachable: nothing is cut off with no way to scroll to it.
    if (slot.getBoundingClientRect().height < 118) {
      expect(panelScrolls).toBe(true);
    }
  });

  it("renders the agent panel about 440 px wide at a 1440 px viewport", async () => {
    await page.viewport(1440, 900);
    await render(<OverlayHost {...host([AGENT_PANEL_ID], "c")} />);
    const width = el("agent-panel").getBoundingClientRect().width;
    expect(width).toBeGreaterThanOrEqual(436);
    expect(width).toBeLessThanOrEqual(444);
  });

  it("leaves other sidebar overlays (the action card) at their previous 360 px width", async () => {
    await page.viewport(1440, 900);
    await render(<OverlayHost {...host(["action-card"], null)} />);
    const width = el("card").getBoundingClientRect().width;
    expect(width).toBeGreaterThanOrEqual(356);
    expect(width).toBeLessThanOrEqual(364);
  });
});
