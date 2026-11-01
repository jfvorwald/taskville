import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { Attention } from "../../../data/domain.ts";
import { createDataStore, type DataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayMode, OverlayProps } from "../../host/types.ts";
import { AGENT_PANEL_ID, AgentPanel, agentPanelOverlay } from "./AgentPanel.tsx";

// M5.05 (ARCHITECTURE.md 2.10, issue #59): the agent panel shell.
//
// Contract pinned here:
//   <AgentPanel {...OverlayProps} store?={DataStore} renderTab?={(tab, agentId) => ReactNode} />
// reads the selected agent from `selection.selectedId`, the agents, tool calls and activity from
// `store.getState().state` (default store: the app store), the attention records from
// `store.getState().attention`, and the clock from `store.now()` (never `Date.now()`).
// It renders NOTHING (no `agent-panel` element) unless `selectedId` is an agent the store knows.
// Navigation goes through `selection.select(id)`; `select(null)` is how the panel closes.
//
// `agentPanelOverlay`: { id: AGENT_PANEL_ID ("agent-panel"), slot: "sidebar",
//   modes: ["live", "history"], Component: AgentPanel }.
//
// Markup:
//   root       data-testid="agent-panel"  data-agent-id  data-kind
//              data-readonly="true" in history mode (absent in live mode)
//   breadcrumb <nav aria-label="Family"> holding one button per crumb, in familyPath order, named
//              by the agent's name; the current agent's crumb has aria-current="true". Any crumb
//              calls select(thatId). Separators are aria-hidden.
//   header     data-testid agent-panel-name | -type | -status | -elapsed | -file
//              name   displayName, else the first 8 characters of the id
//              type   the recorded `role`, else the kind: Lead, Teammate, Subagent, Session, Unknown
//              status the world-label words: "Needs you" while the agent has a needs_you
//                     attention record, otherwise its recorded activity ("Testing", "Idle", ...)
//              elapsed formatElapsed(elapsedMs(agent, store.now())), refreshed at least once a
//                     second; absent when elapsedMs is null
//              file   currentFile(...); the element is absent when no file is observed
//   tabs       role=tablist; one role=tab per visibleTabs, named Live, Files, Crew. Live is
//              selected first. The selected tab's content area is
//              data-testid="agent-panel-tab-slot" with data-tab=<live|files|crew> and holds
//              whatever `renderTab(tab, agentId)` returns (nothing by default). If the selected
//              tab stops being visible (selection moved to a leaf), the panel falls back to Live.
//   keys       "]" selects the next family member and "[" the previous (familyOrder, wrapping),
//              Escape selects null. Handled on the window; ignored when the key event belongs to a
//              text field or dialog or was already handled (the shouldClearOnEscape rule), and
//              "[" / "]" do nothing when the family is only the selected agent.
//
// In history mode the panel is read-only: it changes nothing in the world. Navigating the family
// (crumbs, keys) still works because it only moves the selection. Esc in history is left to the
// history mode ticket (Esc also means "back to live" there) and is not pinned here.
//
// Not pinned: tab contents (M5.06 to M5.08), sharing the sidebar with the action card.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
let clock = NOW;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

// Team T: lead L "Lead"; teammates t2 "Writer" (registered 2) and t1 "Reviewer" (registered 3);
// t1 spawned subagent s1 "Scout". Solo session S "Solo" has no family. Registration order is
// not the order of the record, so a sorted-by-key implementation fails.
type Over = Record<string, unknown>;
const base = {
  registered: true,
  connection: "connected",
  firstSeenAt: iso(-125_000), // 2m 5s before NOW
  lastSeenAt: iso(0),
  toolCallCount: 0,
  consecutiveToolFailures: 0,
};
const mk = (id: string, over: Over) => ({ id, sourceId: "claude-code", ...base, ...over });

const agents = {
  s1: mk("s1", {
    kind: "subagent",
    parentAgentId: "t1",
    displayName: "Scout",
    role: "explorer",
    registeredSeq: 4,
  }),
  t1: mk("t1", { kind: "teammate", teamId: "T", displayName: "Reviewer", registeredSeq: 3 }),
  S: mk("S", { kind: "session", displayName: "Solo", registeredSeq: 5 }),
  t2: mk("t2", { kind: "teammate", teamId: "T", displayName: "Writer", registeredSeq: 2 }),
  L: mk("L", { kind: "lead", teamId: "T", displayName: "Lead", registeredSeq: 1 }),
};

const activity = (agentId: string, name: string) => ({
  agentId,
  activity: name,
  heuristic: false,
  since: iso(-60_000),
  openSessionCount: 1,
});

interface World {
  agents?: Record<string, unknown>;
  activity?: Record<string, unknown>;
  toolCalls?: Record<string, unknown>;
  attention?: Attention[];
  teams?: Record<string, unknown>;
}

function makeStore(world: World = {}): DataStore {
  const store = createDataStore({ now: () => clock });
  store.setState({
    projectId: "proj-1",
    connection: "live",
    attention: world.attention ?? [],
    state: {
      agents: world.agents ?? agents,
      teams: world.teams ?? {},
      activity: world.activity ?? { s1: activity("s1", "testing"), L: activity("L", "idle") },
      toolCalls: world.toolCalls ?? {},
    } as unknown as NonNullable<ReturnType<typeof store.getState>["state"]>,
  });
  return store;
}

function props(
  selectedId: string | null,
  select: (id: string | null) => void = () => {},
  mode: OverlayMode = "live",
): OverlayProps {
  return {
    mode,
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select },
    anchors: createAnchorSource(),
    intents: { available: mode === "live", run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

function recorder() {
  const picked: (string | null)[] = [];
  return { picked, select: (id: string | null) => void picked.push(id) };
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}

const text = (id: string) => page.getByTestId(id);

afterEach(() => {
  clock = NOW;
});

describe("agentPanelOverlay", () => {
  it("is the sidebar overlay for live and history", () => {
    expect(agentPanelOverlay.id).toBe(AGENT_PANEL_ID);
    expect(AGENT_PANEL_ID).toBe("agent-panel");
    expect(agentPanelOverlay.slot).toBe("sidebar");
    expect([...agentPanelOverlay.modes].sort()).toEqual(["history", "live"]);
    expect(agentPanelOverlay.Component).toBe(AgentPanel);
  });
});

describe("AgentPanel presence", () => {
  it("renders nothing when nothing is selected", async () => {
    const { container } = await render(<AgentPanel {...props(null)} store={makeStore()} />);
    expect(container.querySelector('[data-testid="agent-panel"]')).toBeNull();
  });

  it("renders nothing for a building selection or an agent the store does not know", async () => {
    const store = makeStore();
    const a = await render(<AgentPanel {...props("area:library")} store={store} />);
    expect(a.container.querySelector('[data-testid="agent-panel"]')).toBeNull();
    const b = await render(<AgentPanel {...props("ghost")} store={store} />);
    expect(b.container.querySelector('[data-testid="agent-panel"]')).toBeNull();
  });

  it("renders nothing, and does not throw, for an id that is an inherited property name", async () => {
    const store = makeStore();
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const view = await render(<AgentPanel {...props(id)} store={store} />);
      expect(view.container.querySelector('[data-testid="agent-panel"]')).toBeNull();
      await view.unmount();
    }
  });

  it("opens for a lead, a teammate, a subagent and a solo session alike", async () => {
    const store = makeStore();
    const view = await render(<AgentPanel {...props("L")} store={store} />);
    for (const [id, kind] of [
      ["L", "lead"],
      ["t1", "teammate"],
      ["s1", "subagent"],
      ["S", "session"],
    ] as const) {
      await view.rerender(<AgentPanel {...props(id)} store={store} />);
      const root = page.getByTestId("agent-panel");
      await expect.element(root).toHaveAttribute("data-agent-id", id);
      await expect.element(root).toHaveAttribute("data-kind", kind);
    }
  });
});

describe("AgentPanel header", () => {
  it("shows name, recorded type, status and elapsed time from the injected clock", async () => {
    await render(<AgentPanel {...props("s1")} store={makeStore()} />);
    await expect.element(text("agent-panel-name")).toHaveTextContent("Scout");
    await expect.element(text("agent-panel-type")).toHaveTextContent("explorer");
    await expect.element(text("agent-panel-status")).toHaveTextContent("Testing");
    await expect.element(text("agent-panel-elapsed")).toHaveTextContent("2m 5s");
  });

  it("falls back to the kind for the type and to a short id for the name", async () => {
    const store = makeStore({
      agents: { abcdefghijkl: mk("abcdefghijkl", { kind: "session", registeredSeq: 1 }) },
      activity: {},
    });
    await render(<AgentPanel {...props("abcdefghijkl")} store={store} />);
    await expect.element(text("agent-panel-name")).toHaveTextContent("abcdefgh");
    await expect.element(text("agent-panel-name")).not.toHaveTextContent("abcdefghi");
    await expect.element(text("agent-panel-type")).toHaveTextContent("Session");
  });

  it("says Needs you while the agent has a needs_you record, whatever its activity", async () => {
    const store = makeStore({
      attention: [
        {
          agentId: "s1",
          level: "needs_you",
          kind: "permission",
          since: iso(-5_000),
          requestId: "r1",
          heuristic: false,
        },
      ],
    });
    await render(<AgentPanel {...props("s1")} store={store} />);
    await expect.element(text("agent-panel-status")).toHaveTextContent("Needs you");
  });

  it("recomputes elapsed from the store clock as time passes", async () => {
    await render(<AgentPanel {...props("s1")} store={makeStore()} />);
    await expect.element(text("agent-panel-elapsed")).toHaveTextContent("2m 5s");
    clock = NOW + 10_000;
    await expect
      .element(text("agent-panel-elapsed"), { timeout: 3_000 })
      .toHaveTextContent("2m 15s");
  });

  it("stops the clock for a finished agent", async () => {
    const finished = mk("s1", {
      kind: "subagent",
      parentAgentId: "t1",
      displayName: "Scout",
      finishedAt: iso(-65_000), // 60s after it was first seen
    });
    const store = makeStore({ agents: { ...agents, s1: finished } });
    await render(<AgentPanel {...props("s1")} store={store} />);
    await expect.element(text("agent-panel-elapsed")).toHaveTextContent("1m 0s");
  });

  it("shows the current file only when a running tool call names one", async () => {
    const running = {
      id: "c1",
      agentId: "s1",
      phase: "running",
      toolName: "Edit",
      filePaths: ["src/city/path.ts"],
      evidenceIds: [],
      startSeq: 9,
    };
    const view = await render(
      <AgentPanel {...props("s1")} store={makeStore({ toolCalls: { c1: running } })} />,
    );
    await expect.element(text("agent-panel-file")).toHaveTextContent("src/city/path.ts");

    const done = { ...running, phase: "succeeded" };
    await view.rerender(
      <AgentPanel {...props("s1")} store={makeStore({ toolCalls: { c1: done } })} />,
    );
    expect(view.container.querySelector('[data-testid="agent-panel-file"]')).toBeNull();
  });
});

describe("AgentPanel heuristic labels", () => {
  const needsYou = (heuristic: boolean): Attention => ({
    agentId: "s1",
    level: "needs_you",
    kind: "permission",
    since: iso(-5_000),
    requestId: "r1",
    heuristic,
  });

  it("qualifies a heuristic activity as a guess, never as fact", async () => {
    const store = makeStore({
      activity: { s1: { ...activity("s1", "testing"), heuristic: true } },
    });
    await render(<AgentPanel {...props("s1")} store={store} />);
    await expect.element(text("agent-panel-status")).toHaveTextContent("Possibly testing");
  });

  it("qualifies a multi-word heuristic activity the same way", async () => {
    const store = makeStore({
      activity: { s1: { ...activity("s1", "handing_off"), heuristic: true } },
    });
    await render(<AgentPanel {...props("s1")} store={store} />);
    await expect.element(text("agent-panel-status")).toHaveTextContent("Possibly handing off");
  });

  it("shows an observed activity unqualified", async () => {
    await render(<AgentPanel {...props("s1")} store={makeStore()} />);
    const status = text("agent-panel-status");
    await expect.element(status).toHaveTextContent("Testing");
    expect(status.element().textContent).not.toMatch(/possibly/i);
  });

  it("qualifies a heuristic needs-you record as a guess", async () => {
    const store = makeStore({ attention: [needsYou(true)] });
    await render(<AgentPanel {...props("s1")} store={store} />);
    await expect.element(text("agent-panel-status")).toHaveTextContent("Possibly needs you");
  });

  it("shows an observed needs-you record unqualified", async () => {
    const store = makeStore({ attention: [needsYou(false)] });
    await render(<AgentPanel {...props("s1")} store={store} />);
    const status = text("agent-panel-status");
    await expect.element(status).toHaveTextContent("Needs you");
    expect(status.element().textContent).not.toMatch(/possibly/i);
  });
});

describe("AgentPanel breadcrumb", () => {
  it("lists the family from the root to the agent, by name, marking the current one", async () => {
    await render(<AgentPanel {...props("s1")} store={makeStore()} />);
    const nav = page.getByRole("navigation", { name: "Family" });
    const crumbs = nav.getByRole("button");
    await expect.element(crumbs.nth(0)).toHaveTextContent("Lead");
    await expect.element(crumbs.nth(1)).toHaveTextContent("Reviewer");
    await expect.element(crumbs.nth(2)).toHaveTextContent("Scout");
    expect(crumbs.elements()).toHaveLength(3);
    await expect.element(crumbs.nth(2)).toHaveAttribute("aria-current", "true");
    await expect.element(crumbs.nth(0)).not.toHaveAttribute("aria-current", "true");
  });

  it("selects the agent whose crumb is clicked", async () => {
    const { picked, select } = recorder();
    await render(<AgentPanel {...props("s1", select)} store={makeStore()} />);
    const nav = page.getByRole("navigation", { name: "Family" });
    await nav.getByRole("button", { name: "Lead" }).click();
    await nav.getByRole("button", { name: "Reviewer" }).click();
    expect(picked).toEqual(["L", "t1"]);
  });

  it("is a single crumb for a solo session", async () => {
    await render(<AgentPanel {...props("S")} store={makeStore()} />);
    const crumbs = page.getByRole("navigation", { name: "Family" }).getByRole("button");
    expect(crumbs.elements()).toHaveLength(1);
    await expect.element(crumbs.nth(0)).toHaveTextContent("Solo");
  });
});

describe("AgentPanel tabs", () => {
  it("shows Live, Files and Crew for a lead, with Live selected", async () => {
    await render(<AgentPanel {...props("L")} store={makeStore()} />);
    const tabs = page.getByRole("tab");
    expect(tabs.elements().map((e) => e.textContent)).toEqual(["Live", "Files", "Crew"]);
    await expect
      .element(page.getByRole("tab", { name: "Live" }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(text("agent-panel-tab-slot")).toHaveAttribute("data-tab", "live");
  });

  it("shows Crew for a teammate that has a subagent, and not for a leaf", async () => {
    const store = makeStore();
    const view = await render(<AgentPanel {...props("t1")} store={store} />);
    await expect.element(page.getByRole("tab", { name: "Crew" })).toBeVisible();
    await view.rerender(<AgentPanel {...props("t2")} store={store} />);
    expect(
      page
        .getByRole("tab")
        .elements()
        .map((e) => e.textContent),
    ).toEqual(["Live", "Files"]);
    await view.rerender(<AgentPanel {...props("s1")} store={store} />);
    expect(page.getByRole("tab", { name: "Crew" }).elements()).toHaveLength(0);
  });

  it("shows Crew for a solo session only once it has a subagent", async () => {
    const view = await render(<AgentPanel {...props("S")} store={makeStore()} />);
    expect(page.getByRole("tab", { name: "Crew" }).elements()).toHaveLength(0);
    const withChild = {
      ...agents,
      child: mk("child", {
        kind: "subagent",
        parentAgentId: "S",
        displayName: "Kid",
        registeredSeq: 6,
      }),
    };
    await view.rerender(<AgentPanel {...props("S")} store={makeStore({ agents: withChild })} />);
    await expect.element(page.getByRole("tab", { name: "Crew" })).toBeVisible();
  });

  it("switches the tab slot when a tab is chosen and hands the slot to renderTab", async () => {
    const seen: [string, string][] = [];
    await render(
      <AgentPanel
        {...props("L")}
        store={makeStore()}
        renderTab={(tab, agentId) => {
          seen.push([tab, agentId]);
          return <p data-testid="slot-content">{`${tab} for ${agentId}`}</p>;
        }}
      />,
    );
    await expect.element(page.getByTestId("slot-content")).toHaveTextContent("live for L");
    await page.getByRole("tab", { name: "Files" }).click();
    await expect.element(text("agent-panel-tab-slot")).toHaveAttribute("data-tab", "files");
    await expect.element(page.getByTestId("slot-content")).toHaveTextContent("files for L");
    await page.getByRole("tab", { name: "Crew" }).click();
    await expect.element(text("agent-panel-tab-slot")).toHaveAttribute("data-tab", "crew");
    expect(seen).toContainEqual(["crew", "L"]);
  });

  it("renders an explicitly empty slot without invented content", async () => {
    await render(<AgentPanel {...props("L")} store={makeStore()} renderTab={() => null} />);
    await expect.element(text("agent-panel-tab-slot")).toBeEmptyDOMElement();
  });

  it("falls back to Live when the selected tab is not shown for the next agent", async () => {
    const store = makeStore();
    const view = await render(<AgentPanel {...props("L")} store={store} />);
    await page.getByRole("tab", { name: "Crew" }).click();
    await expect.element(text("agent-panel-tab-slot")).toHaveAttribute("data-tab", "crew");
    await view.rerender(<AgentPanel {...props("t2")} store={store} />);
    await expect.element(text("agent-panel-tab-slot")).toHaveAttribute("data-tab", "live");
    await expect
      .element(page.getByRole("tab", { name: "Live" }))
      .toHaveAttribute("aria-selected", "true");
  });
});

describe("AgentPanel keys", () => {
  it("] selects the next family member and [ the previous, in registration order", async () => {
    const { picked, select } = recorder();
    const store = makeStore();
    const view = await render(<AgentPanel {...props("L", select)} store={store} />);
    press("]");
    expect(picked).toEqual(["t2"]); // L, t2, t1, s1
    await view.rerender(<AgentPanel {...props("t1", select)} store={store} />);
    press("]");
    press("[");
    expect(picked).toEqual(["t2", "s1", "t2"]);
  });

  it("wraps from the last member to the first and from the first to the last", async () => {
    const { picked, select } = recorder();
    const store = makeStore();
    const view = await render(<AgentPanel {...props("s1", select)} store={store} />);
    press("]");
    await view.rerender(<AgentPanel {...props("L", select)} store={store} />);
    press("[");
    expect(picked).toEqual(["L", "s1"]);
  });

  it("steps within the family of the selected agent only", async () => {
    const { picked, select } = recorder();
    await render(<AgentPanel {...props("S", select)} store={makeStore()} />);
    press("]");
    press("[");
    expect(picked).toEqual([]);
  });

  it("ignores the keys while typing in a text field", async () => {
    const { picked, select } = recorder();
    const view = await render(
      <div>
        <AgentPanel {...props("L", select)} store={makeStore()} />
        <input aria-label="note" />
      </div>,
    );
    const input = view.container.querySelector("input") as HTMLInputElement;
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(picked).toEqual([]);
  });

  it("Escape closes the panel by clearing the selection, as it does for the city", async () => {
    const { picked, select } = recorder();
    await render(<AgentPanel {...props("s1", select)} store={makeStore()} />);
    press("Escape");
    expect(picked).toEqual([null]);
  });

  it("stops listening when it unmounts", async () => {
    const { picked, select } = recorder();
    const view = await render(<AgentPanel {...props("L", select)} store={makeStore()} />);
    await view.unmount();
    press("]");
    press("Escape");
    expect(picked).toEqual([]);
  });
});

// M5.05 review fixes.
//   - the [ and ] walk is depth first: an earlier sibling's whole subtree before the next sibling;
//   - [ and ] do nothing with Cmd, Ctrl or Alt held, or on a key repeat (CTO decision);
//   - [ and ] do nothing when already handled, inside a dialog, or inside contenteditable;
//   - a self-parent is ignored (no Crew tab, its own root); a parent cycle is rooted at its lowest
//     registeredSeq, then id;
//   - a teammate's lead is `state.teams[teamId].leadAgentId` when recorded (CTO decision): the panel
//     passes `state.teams` to the family functions;
//   - an empty displayName falls back to the first 8 characters of the id, in the header and the
//     crumb, so every crumb button has an accessible name (CTO decision).

describe("AgentPanel keys, depth first", () => {
  // L; t2 (2) with child c (9); t1 (3) with child s1 (4). The walk is L, t2, c, t1, s1.
  const deep = {
    L: agents.L,
    t2: agents.t2,
    t1: agents.t1,
    s1: agents.s1,
    c: mk("c", { kind: "subagent", parentAgentId: "t2", displayName: "Kid", registeredSeq: 9 }),
  };

  it("] walks each subtree before the next sibling, and wraps", async () => {
    const { picked, select } = recorder();
    const store = makeStore({ agents: deep });
    const view = await render(<AgentPanel {...props("L", select)} store={store} />);
    for (const id of ["L", "t2", "c", "t1", "s1"]) {
      await view.rerender(<AgentPanel {...props(id, select)} store={store} />);
      press("]");
    }
    expect(picked).toEqual(["t2", "c", "t1", "s1", "L"]);
  });

  it("[ walks the same order backward", async () => {
    const { picked, select } = recorder();
    const store = makeStore({ agents: deep });
    const view = await render(<AgentPanel {...props("L", select)} store={store} />);
    for (const id of ["L", "s1", "t1", "c", "t2"]) {
      await view.rerender(<AgentPanel {...props(id, select)} store={store} />);
      press("[");
    }
    expect(picked).toEqual(["s1", "t1", "c", "t2", "L"]);
  });
});

describe("AgentPanel keys, modifiers and repeat", () => {
  it("does nothing for [ or ] with Cmd, Ctrl or Alt held", async () => {
    const { picked, select } = recorder();
    await render(<AgentPanel {...props("t1", select)} store={makeStore()} />);
    for (const key of ["[", "]"]) {
      press(key, { metaKey: true });
      press(key, { ctrlKey: true });
      press(key, { altKey: true });
    }
    expect(picked).toEqual([]);
    press("]"); // the handler is live: a plain key still steps
    expect(picked).toEqual(["s1"]);
  });

  it("does nothing for an auto-repeated [ or ]", async () => {
    const { picked, select } = recorder();
    await render(<AgentPanel {...props("t1", select)} store={makeStore()} />);
    press("]", { repeat: true });
    press("[", { repeat: true });
    expect(picked).toEqual([]);
    press("]");
    expect(picked).toEqual(["s1"]);
  });
});

describe("AgentPanel keys, events the panel does not own", () => {
  it("does nothing when the key event was already handled", async () => {
    const { picked, select } = recorder();
    await render(<AgentPanel {...props("t1", select)} store={makeStore()} />);
    const handled = (event: Event) => event.preventDefault();
    document.body.addEventListener("keydown", handled);
    press("]");
    press("[");
    document.body.removeEventListener("keydown", handled);
    expect(picked).toEqual([]);
    press("]");
    expect(picked).toEqual(["s1"]);
  });

  it("does nothing when the target is inside a dialog", async () => {
    const { picked, select } = recorder();
    const view = await render(
      <div>
        <AgentPanel {...props("t1", select)} store={makeStore()} />
        <div role="dialog" aria-label="Settings">
          <button type="button">Inside</button>
        </div>
      </div>,
    );
    const inside = view.container.querySelector('[role="dialog"] button') as HTMLElement;
    press("]", {}, inside);
    press("[", {}, inside);
    expect(picked).toEqual([]);
    press("]");
    expect(picked).toEqual(["s1"]);
  });

  it("does nothing when the target is inside a contenteditable element", async () => {
    const { picked, select } = recorder();
    const view = await render(
      <div>
        <AgentPanel {...props("t1", select)} store={makeStore()} />
        <div contentEditable="true" suppressContentEditableWarning>
          <span data-testid="typed">notes</span>
        </div>
      </div>,
    );
    const typed = view.container.querySelector('[data-testid="typed"]') as HTMLElement;
    expect(typed.isContentEditable).toBe(true);
    press("]", {}, typed);
    press("[", {}, typed);
    expect(picked).toEqual([]);
    press("]");
    expect(picked).toEqual(["s1"]);
  });
});

describe("AgentPanel with a malformed family", () => {
  it("ignores a self-parent: no Crew tab, a single crumb, and the keys go nowhere", async () => {
    const { picked, select } = recorder();
    const store = makeStore({
      agents: {
        x: mk("x", { kind: "subagent", parentAgentId: "x", displayName: "Loop", registeredSeq: 1 }),
      },
      activity: {},
    });
    await render(<AgentPanel {...props("x", select)} store={store} />);
    expect(
      page
        .getByRole("tab")
        .elements()
        .map((e) => e.textContent),
    ).toEqual(["Live", "Files"]);
    const crumbs = page.getByRole("navigation", { name: "Family" }).getByRole("button");
    expect(crumbs.elements()).toHaveLength(1);
    press("]");
    expect(picked).toEqual([]);
  });

  it("roots a parent cycle at its lowest registration, whichever member is open", async () => {
    const store = makeStore({
      agents: {
        a: mk("a", { kind: "subagent", parentAgentId: "b", displayName: "Ann", registeredSeq: 5 }),
        b: mk("b", { kind: "subagent", parentAgentId: "a", displayName: "Bob", registeredSeq: 3 }),
      },
      activity: {},
    });
    const view = await render(<AgentPanel {...props("a")} store={store} />);
    const crumbs = page.getByRole("navigation", { name: "Family" }).getByRole("button");
    expect(crumbs.elements().map((e) => e.textContent)).toEqual(["Bob", "Ann"]);
    await view.rerender(<AgentPanel {...props("b")} store={store} />);
    expect(crumbs.elements().map((e) => e.textContent)).toEqual(["Bob"]);
  });
});

describe("AgentPanel with a recorded team lead", () => {
  // Two lead agents on team T. The earlier one is not the recorded lead.
  const twoLeads = {
    first: mk("first", { kind: "lead", teamId: "T", displayName: "First", registeredSeq: 2 }),
    second: mk("second", { kind: "lead", teamId: "T", displayName: "Second", registeredSeq: 5 }),
    mate: mk("mate", { kind: "teammate", teamId: "T", displayName: "Mate", registeredSeq: 6 }),
  };

  it("puts the recorded lead, not the first registered, above a teammate", async () => {
    const store = makeStore({
      agents: twoLeads,
      activity: {},
      teams: { T: { id: "T", leadAgentId: "second" } },
    });
    await render(<AgentPanel {...props("mate")} store={store} />);
    const crumbs = page.getByRole("navigation", { name: "Family" }).getByRole("button");
    expect(crumbs.elements().map((e) => e.textContent)).toEqual(["Second", "Mate"]);
  });

  it("steps from the recorded lead to its teammate, and not from the other lead", async () => {
    const { picked, select } = recorder();
    const store = makeStore({
      agents: twoLeads,
      activity: {},
      teams: { T: { id: "T", leadAgentId: "second" } },
    });
    const view = await render(<AgentPanel {...props("first", select)} store={store} />);
    press("]");
    press("[");
    expect(picked).toEqual([]);
    await view.rerender(<AgentPanel {...props("second", select)} store={store} />);
    press("]");
    expect(picked).toEqual(["mate"]);
  });

  it("falls back to the first registered lead when the team has no record", async () => {
    const store = makeStore({ agents: twoLeads, activity: {} });
    await render(<AgentPanel {...props("mate")} store={store} />);
    const crumbs = page.getByRole("navigation", { name: "Family" }).getByRole("button");
    expect(crumbs.elements().map((e) => e.textContent)).toEqual(["First", "Mate"]);
  });
});

describe("AgentPanel with an empty display name", () => {
  const unnamed = {
    leadlead01: mk("leadlead01", { kind: "lead", teamId: "T", displayName: "", registeredSeq: 1 }),
    matemate01: mk("matemate01", {
      kind: "teammate",
      teamId: "T",
      displayName: "",
      registeredSeq: 2,
    }),
  };

  it("falls back to the first 8 characters of the id in the header", async () => {
    await render(<AgentPanel {...props("matemate01")} store={makeStore({ agents: unnamed })} />);
    expect(text("agent-panel-name").element().textContent).toBe("matemate");
  });

  it("gives every crumb button an accessible name", async () => {
    const { picked, select } = recorder();
    await render(
      <AgentPanel {...props("matemate01", select)} store={makeStore({ agents: unnamed })} />,
    );
    const nav = page.getByRole("navigation", { name: "Family" });
    expect(
      nav
        .getByRole("button")
        .elements()
        .map((e) => e.textContent),
    ).toEqual(["leadlead", "matemate"]);
    await nav.getByRole("button", { name: "leadlead" }).click();
    expect(picked).toEqual(["leadlead01"]);
  });
});

describe("AgentPanel in history mode", () => {
  it("is marked read-only, and live mode is not", async () => {
    const live = await render(<AgentPanel {...props("L")} store={makeStore()} />);
    await expect.element(page.getByTestId("agent-panel")).not.toHaveAttribute("data-readonly");
    await live.unmount();
    await render(<AgentPanel {...props("L", () => {}, "history")} store={makeStore()} />);
    await expect.element(page.getByTestId("agent-panel")).toHaveAttribute("data-readonly", "true");
  });

  it("still navigates the family, because that only moves the selection", async () => {
    const { picked, select } = recorder();
    await render(<AgentPanel {...props("t1", select, "history")} store={makeStore()} />);
    await page
      .getByRole("navigation", { name: "Family" })
      .getByRole("button", { name: "Lead" })
      .click();
    press("]");
    expect(picked).toEqual(["L", "s1"]);
  });

  it("never sends an intent", async () => {
    const sent: unknown[] = [];
    const p = props("L", () => {}, "history");
    p.intents = { available: false, run: (i) => void sent.push(i) };
    await render(<AgentPanel {...p} store={makeStore()} />);
    await page.getByRole("tab", { name: "Files" }).click();
    press("]");
    expect(sent).toEqual([]);
  });
});

describe("AgentPanel in the sidebar slot", () => {
  it("keeps its margins inside the slot when its content is taller than the slot", async () => {
    const SLOT_HEIGHT = 300;
    const MARGIN = 16;
    const view = await render(
      <div
        data-testid="slot"
        style={{ display: "flow-root", height: `${SLOT_HEIGHT}px`, width: "400px" }}
      >
        <AgentPanel
          {...props("L")}
          store={makeStore()}
          renderTab={() => <div style={{ height: "2000px" }}>tall</div>}
        />
      </div>,
    );
    const slot = view.container.querySelector('[data-testid="slot"]') as HTMLElement;
    const panel = view.container.querySelector('[data-testid="agent-panel"]') as HTMLElement;
    const slotBox = slot.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    // The panel is capped (it scrolls inside) and its bottom margin still fits in the slot.
    expect(box.height).toBeLessThan(2000);
    expect(box.top - slotBox.top).toBeGreaterThanOrEqual(MARGIN - 1);
    expect(slotBox.bottom - box.bottom).toBeGreaterThanOrEqual(MARGIN - 1);
  });
});
