import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { highlightStore } from "../../../city/crew/highlight/highlightStore.ts";
import { createDataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";

// M5.08 red round 3 (S3): AgentPanel wiring. With the Crew tab selected the panel renders the crew
// list and publishes the open agent to `highlightStore`; hovering a row publishes the hovered id;
// leaving the Crew tab, or unmounting, clears both. (Nothing is published while Live is showing.)

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const base = {
  sourceId: "claude-code",
  registered: true,
  connection: "connected",
  firstSeenAt: new Date(NOW - 60_000).toISOString(),
  lastSeenAt: new Date(NOW).toISOString(),
  toolCallCount: 0,
  consecutiveToolFailures: 0,
};
function makeStore() {
  const store = createDataStore({ now: () => NOW });
  store.setState({
    projectId: "proj-1",
    connection: "live",
    attention: [],
    state: {
      agents: {
        L: { id: "L", kind: "lead", teamId: "T", displayName: "Lead", registeredSeq: 1, ...base },
        s1: {
          id: "s1",
          kind: "subagent",
          parentAgentId: "L",
          displayName: "Scout",
          registeredSeq: 2,
          ...base,
        },
      },
      teams: {},
      activity: {},
      toolCalls: {},
    } as never,
  });
  return store;
}
const props = (selectedId: string): OverlayProps => ({
  mode: "live",
  selectors: {
    counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
  },
  selection: { selectedId, select: () => {} },
  anchors: createAnchorSource(),
  intents: { available: true, run: () => {} },
  settings: { get: (_k, f) => f, set: () => {} },
});

afterEach(() => {
  highlightStore.open(null);
  highlightStore.hover(null);
});

describe("AgentPanel Crew tab drives the highlight", () => {
  it("publishes nothing while Live shows", async () => {
    render(<AgentPanel {...props("L")} store={makeStore()} />);
    await expect.element(page.getByTestId("agent-panel")).toBeVisible();
    expect(highlightStore.getSnapshot().openAgentId).toBeNull();
  });

  it("renders the crew list, publishes open and hover, and clears them on leaving the tab", async () => {
    render(<AgentPanel {...props("L")} store={makeStore()} initialTab="crew" />);
    await expect.element(page.getByTestId("crew-list")).toBeVisible();
    expect(highlightStore.getSnapshot().openAgentId).toBe("L");
    await page.getByRole("button", { name: "Scout" }).hover();
    expect(highlightStore.getSnapshot().hoveredId).toBe("s1");
    await page.getByRole("tab", { name: "Live" }).click();
    expect(highlightStore.getSnapshot()).toEqual({ openAgentId: null, hoveredId: null });
  });

  it("clears the highlight when the panel unmounts", async () => {
    const screen = await render(
      <AgentPanel {...props("L")} store={makeStore()} initialTab="crew" />,
    );
    await expect.element(page.getByTestId("crew-list")).toBeVisible();
    await screen.unmount();
    expect(highlightStore.getSnapshot().openAgentId).toBeNull();
  });
});
