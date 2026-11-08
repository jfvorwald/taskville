import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createDataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "./AgentPanel.tsx";

// M10.03 red: the header must not repeat the agent's name. An agent with no family (its
// breadcrumb would hold only itself) renders no Family navigation at all; an agent with a parent
// still shows parent then child, and a click on the parent crumb selects it.

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

const store = (() => {
  const s = createDataStore({ now: () => NOW });
  s.setState({
    projectId: "proj-1",
    connection: "live",
    attention: [],
    state: {
      agents: {
        S: mk("S", { kind: "session", displayName: "Solo", registeredSeq: 1 }),
        L: mk("L", { kind: "lead", displayName: "Lead", registeredSeq: 2 }),
        c: mk("c", {
          kind: "subagent",
          parentAgentId: "L",
          displayName: "Child",
          registeredSeq: 3,
        }),
      },
      teams: {},
      activity: {},
      toolCalls: {},
    } as unknown as NonNullable<ReturnType<typeof s.getState>["state"]>,
  });
  return s;
})();

function props(selectedId: string, select: (id: string | null) => void = () => {}): OverlayProps {
  return {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

const nav = () => page.getByRole("navigation", { name: "Family" });

describe("AgentPanel breadcrumb without family", () => {
  it("renders no Family navigation for a solo session, and still names the agent", async () => {
    await render(<AgentPanel {...props("S")} store={store} />);
    await expect.element(page.getByTestId("agent-panel-name")).toHaveTextContent("Solo");
    expect(nav().elements()).toHaveLength(0);
  });

  it("renders no Family navigation for a lead at the top of its family", async () => {
    await render(<AgentPanel {...props("L")} store={store} />);
    expect(page.getByTestId("agent-panel").element().querySelectorAll("nav")).toHaveLength(0);
  });

  it("shows parent then child for a subagent, and the parent crumb selects the parent", async () => {
    const picked: (string | null)[] = [];
    await render(<AgentPanel {...props("c", (id) => void picked.push(id))} store={store} />);
    const crumbs = nav().getByRole("button");
    expect(crumbs.elements().map((e) => e.textContent)).toEqual(["Lead", "Child"]);
    await expect.element(crumbs.nth(1)).toHaveAttribute("aria-current", "true");
    await crumbs.nth(0).click();
    expect(picked).toEqual(["L"]);
  });
});
