import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import type { Attention } from "../../../data/domain.ts";
import { createDataStore, type DataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { getSettingsStore } from "../../settings/store.ts";
import { AgentPanel } from "./AgentPanel.tsx";

// M9.04: the agent panel header says "on break" for a waiting agent the break plan has on a break.
// Prop: `onBreak?: ReadonlySet<string>` on AgentPanel (ids on break; M9.05 passes the plan's
// `agents` keys). Markup pinned: the status element (data-testid="agent-panel-status") still reads
// exactly "Waiting", and a separate element data-testid="agent-panel-on-break" reads "on break".
// No note unless the agent's status is Waiting, it is in `onBreak`, and Break time is on.
// Run: pnpm --filter @taskville/web test:browser src/overlays/agent-panel/shell/AgentPanel.break

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const agent = (id: string, name: string) => ({
  id,
  sourceId: "claude-code",
  kind: "session",
  displayName: name,
  registered: true,
  registeredSeq: 1,
  connection: "connected",
  firstSeenAt: iso(-125_000),
  lastSeenAt: iso(0),
  toolCallCount: 0,
  consecutiveToolFailures: 0,
});

const activity = (agentId: string, name: string) => ({
  agentId,
  activity: name,
  heuristic: false,
  since: iso(-60_000),
  openSessionCount: 1,
});

function makeStore(name: string, attention: Attention[] = []): DataStore {
  const store = createDataStore({ now: () => NOW });
  store.setState({
    projectId: "proj-1",
    connection: "live",
    attention,
    state: {
      agents: { a1: agent("a1", "Ada") },
      teams: {},
      activity: { a1: activity("a1", name) },
      toolCalls: {},
    } as unknown as NonNullable<ReturnType<typeof store.getState>["state"]>,
  });
  return store;
}

const props: OverlayProps = {
  mode: "live",
  selectors: {
    counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
  },
  selection: { selectedId: "a1", select: () => {} },
  anchors: createAnchorSource(),
  intents: { available: true, run: () => {} },
  settings: { get: (_k, f) => f, set: () => {} },
};

const ON_BREAK = new Set(["a1"]);
const textOf = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim();
const note = () => document.querySelector('[data-testid="agent-panel-on-break"]');

afterEach(() => getSettingsStore().set("breakTime", true));

describe("AgentPanel header on break", () => {
  it("keeps Waiting and adds an 'on break' note for a waiting agent on break", async () => {
    await render(
      <AgentPanel
        {...props}
        renderTab={() => null}
        store={makeStore("waiting")}
        onBreak={ON_BREAK}
      />,
    );
    await expect.poll(() => textOf("agent-panel-status")).toBe("Waiting");
    await expect.poll(() => textOf("agent-panel-on-break")).toBe("on break");
  });

  it("shows no note when the agent is not in the on-break set, or no set is given", async () => {
    const store = makeStore("waiting");
    const view = await render(
      <AgentPanel {...props} renderTab={() => null} store={store} onBreak={new Set()} />,
    );
    await expect.poll(() => textOf("agent-panel-status")).toBe("Waiting");
    expect(note()).toBeNull();
    await view.rerender(<AgentPanel {...props} renderTab={() => null} store={store} />);
    expect(note()).toBeNull();
    expect(document.body.textContent).not.toMatch(/on break/i);
  });

  it("shows no note for working or needs-you with a stale on-break flag", async () => {
    const working = await render(
      <AgentPanel
        {...props}
        renderTab={() => null}
        store={makeStore("testing")}
        onBreak={ON_BREAK}
      />,
    );
    await expect.poll(() => textOf("agent-panel-status")).toBe("Testing");
    expect(note()).toBeNull();
    await working.unmount();

    const needs = {
      id: "att-1",
      agentId: "a1",
      level: "needs_you",
      kind: "permission",
      since: iso(-1000),
    } as unknown as Attention;
    await render(
      <AgentPanel
        {...props}
        renderTab={() => null}
        store={makeStore("waiting", [needs])}
        onBreak={ON_BREAK}
      />,
    );
    await expect.poll(() => textOf("agent-panel-status")).toBe("Needs you");
    expect(note()).toBeNull();
    expect(document.body.textContent).not.toMatch(/on break/i);
  });

  it("shows no note with Break time off, and brings it back when turned on", async () => {
    getSettingsStore().set("breakTime", false);
    await render(
      <AgentPanel
        {...props}
        renderTab={() => null}
        store={makeStore("waiting")}
        onBreak={ON_BREAK}
      />,
    );
    await expect.poll(() => textOf("agent-panel-status")).toBe("Waiting");
    expect(note()).toBeNull();
    expect(document.body.textContent).not.toMatch(/on break/i);
    getSettingsStore().set("breakTime", true);
    await expect.poll(() => textOf("agent-panel-on-break")).toBe("on break");
  });
});
