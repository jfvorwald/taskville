import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { initialState } from "../../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { createDataStore, type DataStore } from "../../../data/store.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";
import { bodyOf, paint, turn } from "./liveKit.tsx";

// Synthetic M5.17 wire data. Real default AgentPanel, native layout and scroll events.
const A = "m517-agent";
const B = "m517-other";
const PROJECT = "m517-project";
const SECRET = "synthetic-m517-pairing";
const path = (n: number) => `/synthetic/m517/call-${n}.txt`;
const idOf = (n: number) => `m517-${n}:input`;
const call = (n: number, agentId = A): ToolCallFrame => ({
  toolCallId: `m517-${n}`,
  agentId,
  toolName: "Write",
  phase: "succeeded",
  filePaths: [path(n)],
  durationMs: 17,
  evidence: { input: { id: idOf(n), status: "stored" }, output: null },
});
const slot = () => page.getByTestId("agent-panel-tab-slot");
const articles = () => slot().getByRole("article");
const card = (n: number) => articles().filter({ hasText: path(n) });
let backlog: ToolCallFrame[];
let hits: string[];
let mountedEver: Set<string>;
let observer: MutationObserver;
let held: boolean;
let pending: { id: string; signal: AbortSignal | null; release: () => void }[];
let active: number;
let peak: number;
let feeds: {
  signal: AbortSignal | null;
  cancelled: boolean;
  send: (frame: ToolCallFrame) => void;
}[];
function recordMounted() {
  for (const el of document.querySelectorAll('[role="feed"] article')) {
    const n = Number(el.getAttribute("aria-posinset")) - 1;
    if (n >= 0) mountedEver.add(idOf(n));
  }
}
function seed(store: DataStore, project = PROJECT) {
  store.getState().reset(project);
  store.getState().applySnapshotState({
    ...initialState(project),
    agents: Object.fromEntries(
      [A, B].map((id) => [
        id,
        {
          id,
          sourceId: "claude-code",
          kind: "session" as const,
          displayName: id,
          registered: true,
          connection: "connected" as const,
          toolCallCount: 0,
          consecutiveToolFailures: 0,
          firstSeenAt: "2026-11-01T00:00:00Z",
          lastSeenAt: "2026-11-01T00:00:00Z",
        },
      ]),
    ),
  });
}
function props(id: string): OverlayProps {
  return {
    mode: "live",
    selection: { selectedId: id, select: vi.fn() },
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    anchors: createAnchorSource(),
    intents: { available: true, run: vi.fn() },
    settings: { get: (_key, fallback) => fallback, set: vi.fn() },
  };
}
function panel(store: DataStore, id = A, secret = SECRET) {
  return (
    <div style={{ height: 460, width: 400, display: "flow-root" }}>
      <SessionProvider value={secret}>
        <AgentPanel {...props(id)} store={store} />
      </SessionProvider>
    </div>
  );
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
  throw new Error("Expected overflowing real Live viewport");
}
async function scroll(viewport: HTMLElement, top: number) {
  viewport.scrollTop = top;
  await paint();
}
async function mount(count: number) {
  backlog = Array.from({ length: count }, (_, n) => call(n));
  const store = createDataStore();
  seed(store);
  const view = await render(panel(store));
  await expect.poll(() => articles().elements().length).toBeGreaterThan(0);
  await expect.element(card(count - 1)).toBeVisible();
  await paint();
  return { store, view, viewport: scroller() };
}
beforeEach(() => {
  backlog = [];
  hits = [];
  mountedEver = new Set();
  held = false;
  pending = [];
  feeds = [];
  active = 0;
  peak = 0;
  observer = new MutationObserver(recordMounted);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  selectProject(PROJECT);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.startsWith("/v1/evidence/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
      recordMounted();
      hits.push(id);
      active++;
      peak = Math.max(peak, active);
      const n = Number(id.match(/m517-(\d+):input/)?.[1]);
      const response = () => {
        active--;
        return Response.json(
          bodyOf(
            `m517-${n}`,
            "input",
            JSON.stringify({ file_path: path(n), content: `BODY-${n}` }),
            [],
            PROJECT,
          ),
        );
      };
      if (held)
        return new Promise<Response>((resolve) => {
          pending.push({ id, signal: init?.signal ?? null, release: () => resolve(response()) });
        });
      return response();
    }
    if (!/^\/v1\/agents\/[^/]+\/feed$/.test(url.pathname))
      throw new Error(`Unexpected synthetic route ${url.pathname}`);
    const agent = decodeURIComponent(url.pathname.split("/")[3]);
    const feed = { signal: init?.signal ?? null, cancelled: false, send: (_: ToolCallFrame) => {} };
    feeds.push(feed);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          let sequence = 0;
          feed.send = (frame) => {
            if (!feed.cancelled)
              controller.enqueue(
                new TextEncoder().encode(
                  `id: ${++sequence}\nevent: toolcall\ndata: ${JSON.stringify(frame)}\n\n`,
                ),
              );
          };
          for (const frame of backlog) feed.send({ ...frame, agentId: agent });
        },
        cancel() {
          feed.cancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
});
afterEach(() => {
  observer.disconnect();
  held = false;
  for (const request of pending) request.release();
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
});

describe("M5.17 visible evidence through default paired AgentPanel", () => {
  it("opens 2,000 calls reading only rows actually mounted, including existing overscan", async () => {
    await mount(2000);
    await expect.element(card(1999)).toMatchTextContent("BODY-1999");
    await turn();
    // Include transient mount ranges while initial follow settles, not only the final DOM.
    expect(mountedEver.size).toBeLessThan(100);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.filter((id) => !mountedEver.has(id)).length).toBe(0);
    expect(new Set(hits).size).toBeLessThanOrEqual(mountedEver.size);
    expect(card(1999).element().getAttribute("aria-setsize")).toBe("2000");
  });

  it("loads new rows on navigation instead of prefetching the whole history", async () => {
    const { viewport } = await mount(2000);
    await expect.element(card(1999)).toMatchTextContent("BODY-1999");
    await turn();
    const before = hits.length;
    const previous = new Set(hits);
    await scroll(viewport, viewport.scrollHeight / 2);
    await expect.poll(() => hits.length).toBeGreaterThan(before);
    const n = Number(articles().elements()[0]?.getAttribute("aria-posinset")) - 1;
    await expect.element(card(n)).toMatchTextContent(`BODY-${n}`);
    expect(previous.has(idOf(n))).toBe(false);
    expect(hits.slice(before).filter((id) => !mountedEver.has(id))).toEqual([]);
    expect(card(n).element().getAttribute("aria-setsize")).toBe("2000");
  });

  it("refetches an old body after more than 128 other bodies, retaining all call metadata", async () => {
    const { viewport } = await mount(180);
    await expect.element(card(179)).toMatchTextContent("BODY-179");
    await turn();
    const firstReads = hits.filter((id) => id === idOf(179)).length;
    await scroll(viewport, 0);
    await expect.element(card(0)).toMatchTextContent("BODY-0");
    const traversed = new Set<string>();
    // Walk actual measured viewports. Stop before returning to the original newest row.
    for (let step = 0; step < 180 && traversed.size <= 128; step++) {
      for (const el of articles().elements()) {
        const n = Number(el.getAttribute("aria-posinset")) - 1;
        if (n < 170 && el.textContent?.includes(`BODY-${n}`)) traversed.add(idOf(n));
      }
      await scroll(viewport, viewport.scrollTop + viewport.clientHeight * 0.8);
      await turn(20);
    }
    expect(traversed.size).toBeGreaterThan(128);
    // Avoid claiming an exact resident memory bound from these observable reads alone.
    await scroll(viewport, viewport.scrollHeight);
    await expect.element(card(179)).toMatchTextContent("BODY-179");
    await expect
      .poll(() => hits.filter((id) => id === idOf(179)).length)
      .toBeGreaterThan(firstReads);
    expect(card(179).element().getAttribute("aria-setsize")).toBe("180");
    await scroll(viewport, 0);
    await expect.element(card(0)).toMatchTextContent("17 ms");
    expect(card(0).element().getAttribute("aria-setsize")).toBe("180");
  });

  it.each(["agent", "project", "session", "unmount"] as const)(
    "fences late mounted evidence and cancels queued work on %s cleanup",
    async (change) => {
      held = true;
      const { store, view } = await mount(24);
      await expect.poll(() => pending.length).toBe(4);
      const oldRequests = pending.slice();
      const oldFeed = feeds[0];
      if (change === "agent") await view.rerender(panel(store, B));
      else if (change === "project") {
        selectProject("m517-next-project");
        seed(store, "m517-next-project");
      } else if (change === "session") await view.rerender(panel(store, A, "synthetic-new-secret"));
      else await view.unmount();
      await expect
        .poll(
          () =>
            oldFeed.cancelled &&
            oldFeed.signal?.aborted &&
            oldRequests.every((request) => request.signal?.aborted),
        )
        .toBe(true);
      if (change !== "unmount") {
        // Let the replacement scope fill its independent four slots before measuring old work.
        await expect.poll(() => pending.length).toBe(8);
      }
      const boundary = hits.length;
      // Intentionally ignore abort at the fake transport to test the client fence itself.
      for (const request of oldRequests) request.release();
      await turn();
      for (const request of oldRequests) {
        const n = Number(request.id.match(/m517-(\d+):input/)?.[1]);
        expect(document.body.textContent).not.toContain(`BODY-${n}`);
      }
      expect(hits.length).toBe(boundary);
      if (change !== "unmount") await view.unmount();
    },
  );

  it("retains the four-read concurrency cap for mounted evidence", async () => {
    held = true;
    const { view } = await mount(24);
    await expect.poll(() => pending.length).toBe(4);
    await turn();
    expect(peak).toBe(4);
    expect(active).toBe(4);
    held = false;
    for (const request of pending) request.release();
    await expect.element(card(23)).toMatchTextContent("BODY-23");
    expect(peak).toBeLessThanOrEqual(4);
    await view.unmount();
    expect(feeds.every((feed) => feed.signal?.aborted)).toBe(true);
  });
});
