import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { message, PROJECT } from "../../../city/crew/envelopes/envelopeFixtures.ts";
import { createFeedFocus, type FeedFocus } from "../../../city/crew/envelopes/feedFocus.ts";
import { initialState } from "../../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { createDataStore, type DataStore } from "../../../data/store.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";

// M5.04 red round 2 (roborev panel 6818): clicking an envelope must show the message itself in the
// sender's Live feed, not just open the tab. The harness is the M5.06 follow one: the real
// paired AgentPanel over a fake feed stream. Entirely synthetic.
//
// Contract for the implementer: the card for a message event is the sender's `SendMessage` tool
// call that started last at or before the event's `occurredAt` (the crew mapper emits the event
// on the call's PostToolUse). The panel learns the event's time from `store.onEvent`. Given a
// `feedFocus` request (sender, eventId) it scrolls that card into view and focuses the card's
// `article` (the way Jump to latest focuses the newest card), whatever the scroll position.

const A = "synthetic-envelope-sender";
const SECRET = "synthetic-envelope-pairing";
const SEND_NEAR_TOP = 5;
const SEND_NEAR_BOTTOM = 34;
const TOTAL = 40;
const path = (n: number) => `/synthetic/envelope/call-${String(n).padStart(4, "0")}.txt`;
const startedAt = (n: number) => `2026-11-01T00:00:${String(n).padStart(2, "0")}.000Z`;
const between = (n: number) => `2026-11-01T00:00:${String(n).padStart(2, "0")}.500Z`;
const call = (n: number): ToolCallFrame => ({
  toolCallId: `synthetic-envelope-call-${n}`,
  agentId: A,
  toolName: n === SEND_NEAR_TOP || n === SEND_NEAR_BOTTOM ? "SendMessage" : "Write",
  phase: "succeeded",
  startedAt: startedAt(n),
  filePaths: [path(n)],
  evidence: { input: null, output: null },
});

const slot = () => page.getByTestId("agent-panel-tab-slot");
const articles = () => slot().getByRole("article");
const card = (n: number) => articles().filter({ hasText: path(n) });
const paint = async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};

function props(): OverlayProps {
  return {
    mode: "live",
    selection: { selectedId: A, select: vi.fn() },
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    anchors: createAnchorSource(),
    intents: { available: true, run: vi.fn() },
    settings: { get: (_key, fallback) => fallback, set: vi.fn() },
  };
}

function seed(store: DataStore) {
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState({
    ...initialState(PROJECT),
    agents: {
      [A]: {
        id: A,
        sourceId: "claude-code",
        kind: "session" as const,
        displayName: "Sender",
        registered: true,
        connection: "connected" as const,
        toolCallCount: 0,
        consecutiveToolFailures: 0,
        firstSeenAt: "2026-11-01T00:00:00Z",
        lastSeenAt: "2026-11-01T00:00:00Z",
      },
    },
  });
}

async function mount() {
  const store = createDataStore();
  seed(store);
  const feedFocus: FeedFocus = createFeedFocus();
  await render(
    <div style={{ height: 460, width: 400, display: "flow-root" }}>
      <SessionProvider value={SECRET}>
        <AgentPanel {...props()} store={store} feedFocus={feedFocus} />
      </SessionProvider>
    </div>,
  );
  await expect.poll(() => articles().elements().length).toBeGreaterThan(0);
  await paint();
  return { store, feedFocus };
}

function scroller(): HTMLElement {
  let node = articles().elements()[0]?.parentElement;
  while (node) {
    if (
      /(auto|scroll)/.test(getComputedStyle(node).overflowY) &&
      node.clientHeight > 0 &&
      node.scrollHeight > node.clientHeight + 20
    )
      return node;
    node = node.parentElement;
  }
  throw new Error("Mounted constrained Live panel has no overflowing scroll viewport");
}

function visible(n: number, viewport: HTMLElement) {
  const element = card(n).elements()[0];
  if (!element) return false;
  const box = element.getBoundingClientRect();
  const clip = viewport.getBoundingClientRect();
  return box.top >= clip.top - 2 && box.bottom <= clip.bottom + 2;
}

async function scrollTo(viewport: HTMLElement, top: number) {
  viewport.scrollTop = top;
  await paint();
}

beforeEach(() => {
  selectProject(PROJECT);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin);
    if (!/^\/v1\/agents\/[^/]+\/feed$/.test(url.pathname))
      throw new Error(`Unexpected synthetic route ${url.pathname}`);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          Array.from({ length: TOTAL }, (_, i) => call(i)).forEach((frame, i) => {
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${i + 1}\nevent: toolcall\ndata: ${JSON.stringify(frame)}\n\n`,
              ),
            );
          });
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          });
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
});

describe("an envelope click shows the message in the sender's Live feed", () => {
  it("scrolls up to an older message card from the newest end and focuses it", async () => {
    const { store, feedFocus } = await mount();
    const viewport = scroller();
    await scrollTo(viewport, viewport.scrollHeight);
    await expect.poll(() => visible(TOTAL - 1, viewport)).toBe(true);
    expect(visible(SEND_NEAR_TOP, viewport)).toBe(false);

    const event = message(A, "bo", "hi bo", between(SEND_NEAR_TOP));
    store.getState().applyEvent(event);
    feedFocus.request(A, event.eventId);

    await expect.poll(() => visible(SEND_NEAR_TOP, viewport), { timeout: 5_000 }).toBe(true);
    expect(document.activeElement).toBe(card(SEND_NEAR_TOP).element());
  });

  it("scrolls down to a newer message card from older entries and picks the right one of two", async () => {
    const { store, feedFocus } = await mount();
    const viewport = scroller();
    await scrollTo(viewport, 0);
    await expect.poll(() => visible(0, viewport)).toBe(true);
    expect(visible(SEND_NEAR_BOTTOM, viewport)).toBe(false);

    const event = message(A, "bo", "hi bo", between(SEND_NEAR_BOTTOM));
    store.getState().applyEvent(event);
    feedFocus.request(A, event.eventId);

    await expect.poll(() => visible(SEND_NEAR_BOTTOM, viewport), { timeout: 5_000 }).toBe(true);
    expect(document.activeElement).toBe(card(SEND_NEAR_BOTTOM).element());
  });
});
