import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import type { Attention } from "../../data/domain.ts";
import { createDataStore, type DataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { createAnchorSource } from "../host/anchors.ts";
import type { OverlayMode, OverlayProps } from "../host/types.ts";
import { ActionCard } from "./ActionCard.tsx";
import type { CardTarget } from "./target.ts";

// M6.10 (#312): card polish after M6.03.
//   (a) a live heuristic request shows the "Possibly needs you" hint (the flag is read from the
//       request record, not the attention record);
//   (d) the "Waiting" fact recomputes right after a seek (store state and clock change), without
//       waiting for the 1 s interval.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const SINCE = new Date(NOW - 125_000).toISOString(); // waiting 2m 5s
let clock = NOW;

const request = (over: Record<string, unknown> = {}) => ({
  id: "req-1",
  agentId: "a1",
  sessionId: "sess-1",
  kind: "permission",
  toolName: "Bash",
  inputPreview: "npm test",
  answerable: false,
  openedAt: SINCE,
  state: "open",
  late: false,
  mergedRequestIds: [],
  ...over,
});

const needsYou: Attention = {
  agentId: "a1",
  level: "needs_you",
  kind: "permission",
  since: SINCE,
  requestId: "req-1",
  heuristic: false,
};

function worldState(requestOver: Record<string, unknown> = {}) {
  return {
    agents: { a1: { id: "a1", displayName: "Ada" } },
    requests: { "req-1": request(requestOver) },
    sessions: {},
  } as never;
}

function makeStore(requestOver: Record<string, unknown> = {}): DataStore {
  const store = createDataStore({ now: () => clock });
  store.setState({
    projectId: "proj-1",
    connection: "live",
    attention: [needsYou],
    state: worldState(requestOver),
  });
  return store;
}

function props(mode: OverlayMode): OverlayProps {
  return {
    mode,
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId: "a1", select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: mode === "live", run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

const noFetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

function tree(store: DataStore, mode: OverlayMode, recordedTarget?: CardTarget | null) {
  return (
    <SessionProvider value="secret-1">
      <div style={{ position: "relative", width: 360, height: 640 }}>
        <ActionCard
          {...props(mode)}
          store={store}
          fetch={noFetch}
          recordedTarget={recordedTarget}
        />
      </div>
    </SessionProvider>
  );
}

const cardText = () =>
  document.querySelector<HTMLElement>('[data-testid="action-card"]')?.textContent ?? "";

function recorded(over: Partial<CardTarget> = {}): CardTarget {
  return {
    agentId: "a1",
    agentName: "Ada",
    requestId: "req-1",
    sessionId: "sess-1",
    toolName: "Bash",
    inputPreview: "npm test",
    reason: undefined,
    sinceMs: NOW - 125_000,
    answerable: false,
    requestState: "open",
    ...over,
  };
}

beforeEach(() => {
  clock = NOW;
});
afterEach(() => {
  clock = NOW;
});

describe("ActionCard: live heuristic hint (M6.10 a)", () => {
  it("shows 'Possibly needs you' for a live heuristic request", async () => {
    await render(tree(makeStore({ heuristic: true }), "live"));
    await expect.poll(cardText).toContain("Possibly needs you");
  });

  it("shows no hint for an ordinary live request", async () => {
    await render(tree(makeStore({ heuristic: false }), "live"));
    await expect.poll(cardText).toContain("Ada");
    expect(cardText()).not.toContain("Possibly needs you");
  });
});

describe("ActionCard: Waiting recomputes after a seek (M6.10 d)", () => {
  // Well under the 1 s interval, so only an immediate recompute can pass.
  const FAST = { timeout: 500, interval: 25 };

  it("updates when the store clock and state change together, as a seek does", async () => {
    const store = makeStore();
    await render(tree(store, "history", recorded()));
    await expect.poll(cardText).toContain("2m 5s");
    clock = NOW + 60_000;
    store.setState({ state: worldState({ openedAt: SINCE }) });
    await expect.poll(cardText, FAST).toContain("3m 5s");
  });

  it("updates when the recorded target is replaced after the clock moved", async () => {
    const store = makeStore();
    const view = await render(tree(store, "history", recorded()));
    await expect.poll(cardText).toContain("2m 5s");
    clock = NOW + 60_000;
    await view.rerender(tree(store, "history", recorded()));
    await expect.poll(cardText, FAST).toContain("3m 5s");
  });
});
