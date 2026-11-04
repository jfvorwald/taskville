import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createDataStore, type DataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";

// M5.12 (ARCHITECTURE.md 5.1 and 10, issue #104): the agent panel header shows the tokens and
// cost of the selected agent when Claude Code's OpenTelemetry export reported them, and nothing
// when it did not (constitution IV: no invented zero).
//
// Contract pinned here:
//   <AgentPanel ... costSource?={CostSource} />
//   type CostSource = (agentId: string, signal: AbortSignal) => Promise<AgentCostView | undefined>
//   type AgentCostView = { tokens: { input, output, cacheRead, cacheCreation }, costUsd }
// `undefined` (no telemetry for the agent, the engine's 404 `no_cost`), a rejected promise, and an
// absent `costSource` all mean "nothing to show". The default `costSource` in the app reads
// `GET /v1/agents/:id/cost` (engine side: apps/engine/test/sources/otlp). The panel asks again
// when the selected agent changes and ignores an answer for an agent that is no longer selected.
// History mode asks too (the figure is the same session's); nothing here writes anything.
//
// Markup, inside the panel's <header> (the element that holds `agent-panel-name`):
//   data-testid="agent-panel-cost"    present only when a CostView arrived
//     data-testid="agent-panel-tokens"  `<n> tokens`: the sum of the four token types, as
//                                     formatTokens: below 1,000 the integer, below 1,000,000 one
//                                     decimal and `k` (12,345 is "12.3k", 10,000 is "10k": a
//                                     trailing ".0" is dropped), from 1,000,000 one decimal and
//                                     `M`. Data attributes carry the raw counts: data-input,
//                                     data-output, data-cache-read, data-cache-creation.
//     data-testid="agent-panel-cost-usd" `$0.42` (two decimals); a positive cost under one cent is
//                                     "<$0.01"; zero is "$0.00".
// The pure helpers are `formatTokens(n)` and `formatCostUsd(usd)` in cost/format.ts.

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const base = {
  registered: true,
  connection: "connected",
  firstSeenAt: new Date(NOW - 60_000).toISOString(),
  lastSeenAt: new Date(NOW).toISOString(),
  toolCallCount: 0,
  consecutiveToolFailures: 0,
};
const mk = (id: string, over: Record<string, unknown>) => ({
  id,
  sourceId: "claude-code",
  ...base,
  ...over,
});

function makeStore(): DataStore {
  const store = createDataStore({ now: () => NOW });
  store.setState({
    projectId: "proj-1",
    connection: "live",
    attention: [],
    state: {
      agents: {
        L: mk("L", { kind: "lead", displayName: "Lead", registeredSeq: 1 }),
        s1: mk("s1", {
          kind: "subagent",
          parentAgentId: "L",
          displayName: "Scout",
          registeredSeq: 2,
        }),
        s2: mk("s2", {
          kind: "subagent",
          parentAgentId: "L",
          displayName: "Quiet",
          registeredSeq: 3,
        }),
      },
      teams: {},
      activity: {},
      toolCalls: {},
    } as unknown as NonNullable<ReturnType<typeof store.getState>["state"]>,
  });
  return store;
}

function props(selectedId: string | null): OverlayProps {
  return {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

type View = {
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  costUsd: number;
};
type CostSource = (agentId: string, signal: AbortSignal) => Promise<View | undefined>;

// Panel props the shell does not declare yet are passed by spread, so a missing prop is a
// failing assertion here and not a type error that hides the whole file.
const panel = (id: string | null, costSource?: CostSource) => {
  const extra = costSource === undefined ? {} : { costSource };
  return <AgentPanel {...props(id)} store={makeStore()} renderTab={() => null} {...extra} />;
};

// 2,000 + 345 + 9,000 + 1,000 = 12,345 tokens.
const LEAD: View = {
  tokens: { input: 2000, output: 345, cacheRead: 9000, cacheCreation: 1000 },
  costUsd: 0.4237,
};
// 600 + 400 = 1,000 tokens exactly; a cost under one cent.
const SCOUT: View = {
  tokens: { input: 600, output: 400, cacheRead: 0, cacheCreation: 0 },
  costUsd: 0.004,
};
const source: CostSource = async (id) => (id === "L" ? LEAD : id === "s1" ? SCOUT : undefined);

const cost = () => document.querySelector('[data-testid="agent-panel-cost"]');

afterEach(() => {
  document.body.innerHTML = "";
});

describe("agent panel header: tokens and cost", () => {
  it("shows the selected agent's tokens and cost in the header", async () => {
    await render(panel("L", source));
    await expect.element(page.getByTestId("agent-panel-tokens")).toHaveTextContent("12.3k tokens");
    await expect.element(page.getByTestId("agent-panel-cost-usd")).toHaveTextContent("$0.42");
    const header = document.querySelector("header");
    expect(header?.contains(document.querySelector('[data-testid="agent-panel-name"]'))).toBe(true);
    expect(header?.contains(cost())).toBe(true);
  });

  it("carries the raw counts as data attributes", async () => {
    await render(panel("L", source));
    const tokens = page.getByTestId("agent-panel-tokens");
    await expect.element(tokens).toHaveAttribute("data-input", "2000");
    await expect.element(tokens).toHaveAttribute("data-output", "345");
    await expect.element(tokens).toHaveAttribute("data-cache-read", "9000");
    await expect.element(tokens).toHaveAttribute("data-cache-creation", "1000");
  });

  it("formats an exact thousand without a trailing .0 and a sub-cent cost as <$0.01", async () => {
    await render(panel("s1", source));
    await expect.element(page.getByTestId("agent-panel-tokens")).toHaveTextContent("1k tokens");
    await expect.element(page.getByTestId("agent-panel-cost-usd")).toHaveTextContent("<$0.01");
  });

  it("shows the subagent's own figures when the selection moves to it, not the lead's", async () => {
    const asked: string[] = [];
    const recording: CostSource = async (id, signal) => {
      asked.push(id);
      return source(id, signal);
    };
    const view = await render(panel("L", recording));
    await expect.element(page.getByTestId("agent-panel-tokens")).toHaveTextContent("12.3k tokens");
    await view.rerender(panel("s1", recording));
    await expect.element(page.getByTestId("agent-panel-tokens")).toHaveTextContent("1k tokens");
    expect(asked).toContain("s1");
  });

  it("shows nothing for an agent without telemetry, and drops the previous agent's figures", async () => {
    const view = await render(panel("L", source));
    await expect.element(page.getByTestId("agent-panel-cost")).toBeVisible();
    await view.rerender(panel("s2", source));
    await expect.element(page.getByTestId("agent-panel-name")).toHaveTextContent("Quiet");
    await expect.poll(cost).toBeNull();
    expect(document.body.textContent).not.toMatch(/tokens|\$\d/);
  });

  it("shows nothing when no cost source is given or the source fails", async () => {
    const none = await render(panel("L"));
    await expect.element(page.getByTestId("agent-panel-name")).toBeVisible();
    expect(cost()).toBeNull();
    await none.unmount();
    const failing: CostSource = () => Promise.reject(new Error("engine down"));
    await render(panel("L", failing));
    await expect.element(page.getByTestId("agent-panel-name")).toBeVisible();
    await expect.poll(cost).toBeNull();
  });

  it("ignores a slow answer for an agent that is no longer selected", async () => {
    let releaseLead: (v: View) => void = () => {};
    const slow: CostSource = (id, signal) =>
      id === "L"
        ? new Promise<View>((resolve) => {
            releaseLead = resolve;
            signal.addEventListener("abort", () => {});
          })
        : source(id, signal);
    const view = await render(panel("L", slow));
    await view.rerender(panel("s1", slow));
    await expect.element(page.getByTestId("agent-panel-tokens")).toHaveTextContent("1k tokens");
    releaseLead(LEAD);
    await new Promise((r) => setTimeout(r, 50));
    await expect.element(page.getByTestId("agent-panel-tokens")).toHaveTextContent("1k tokens");
    expect(document.body.textContent).not.toContain("12.3k");
  });
});
