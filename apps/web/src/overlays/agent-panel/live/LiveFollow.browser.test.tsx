import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { initialState } from "../../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { createDataStore, type DataStore } from "../../../data/store.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";
import { LiveTab } from "./LiveTab.tsx";

// Entire recording is synthetic, not raw S-2. No evidence bodies or external actions.
const A = "synthetic-follow-agent";
const B = "synthetic-follow-other";
const PROJECT = "synthetic-follow";
const SECRET = "synthetic-follow-pairing";
const path = (n: number) => `/synthetic/follow/call-${String(n).padStart(4, "0")}.txt`;
const call = (n: number, agentId = A): ToolCallFrame => ({
  toolCallId: `synthetic-call-${n}`,
  agentId,
  toolName: "Write",
  phase: "running",
  filePaths: [path(n)],
  evidence: { input: null, output: null },
});
interface Feed {
  project: string | null;
  agent: string;
  signal: AbortSignal | null;
  cancelled: boolean;
  send: (data: ToolCallFrame) => void;
}
let feeds: Feed[];
let backlog: ToolCallFrame[];
let releaseEvidence: (() => void) | undefined;
let evidenceSignal: AbortSignal | null | undefined;
const slot = () => page.getByTestId("agent-panel-tab-slot");
const articles = () => slot().getByRole("article");
const card = (n: number) => articles().filter({ hasText: path(n) });
const jump = () => slot().getByRole("button", { name: /jump to latest/i });
const paint = async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};
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
function panel(store: DataStore, id = A) {
  return (
    <div style={{ height: 460, width: 400, display: "flow-root" }}>
      <SessionProvider value={SECRET}>
        <AgentPanel {...props(id)} store={store} />
      </SessionProvider>
    </div>
  );
}
async function mount() {
  backlog = Array.from({ length: 24 }, (_, i) => call(i));
  const store = createDataStore();
  seed(store);
  const view = await render(panel(store));
  await expect.poll(() => feeds.length).toBe(1);
  await expect.poll(() => articles().elements().length).toBeGreaterThan(0);
  await paint();
  return { store, view };
}
// Discover the actual scrolling ancestor, allowing green to place scrolling in the panel or list.
// Never add overflow/height to production nodes, or replace scroll APIs with spies.
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
async function scroll(viewport: HTMLElement, top: number) {
  viewport.scrollTop = top;
  // Native scrollTop produces a browser scroll event; await layout and that event's handlers.
  await paint();
}
async function bottom() {
  const viewport = scroller();
  await scroll(viewport, viewport.scrollHeight);
  return viewport;
}
function current(agent = A, project = PROJECT) {
  const feed = feeds.findLast((f) => f.agent === agent && f.project === project);
  if (!feed) throw new Error("Expected paired synthetic feed not connected");
  return feed;
}
async function append(n: number) {
  current().send(call(n));
  // Calls at bottom might be unmounted while paused; feed processing still needs a render turn.
  await paint();
}
async function paused() {
  const viewport = await bottom();
  await scroll(viewport, Math.max(0, viewport.scrollTop - viewport.clientHeight));
  return viewport;
}

beforeEach(() => {
  feeds = [];
  backlog = [];
  releaseEvidence = undefined;
  evidenceSignal = undefined;
  selectProject(PROJECT);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), location.origin), init);
    const url = new URL(request.url);
    if (url.pathname === "/v1/evidence/synthetic-held") {
      evidenceSignal = init?.signal;
      return new Promise<Response>((resolve) => {
        releaseEvidence = () =>
          resolve(
            Response.json({
              id: "synthetic-held",
              projectId: PROJECT,
              toolCallId: "synthetic-call-23",
              part: "input",
              text: JSON.stringify({ content: "SYNTHETIC STALE BODY" }),
              bytes: new TextEncoder().encode(JSON.stringify({ content: "SYNTHETIC STALE BODY" }))
                .length,
              truncated: false,
              masks: [],
            }),
          );
      });
    }
    if (!/^\/v1\/agents\/[^/]+\/feed$/.test(url.pathname))
      throw new Error(`Unexpected synthetic route ${url.pathname}`);
    expect(request.method).toBe("GET");
    expect(request.headers.get("X-Taskville-Session")).toBe(SECRET);
    const feed: Feed = {
      project: url.searchParams.get("projectId"),
      agent: decodeURIComponent(url.pathname.split("/")[3]),
      signal: init?.signal ?? null,
      cancelled: false,
      send: () => {},
    };
    feeds.push(feed);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          let sequence = 0;
          feed.send = (data) => {
            // Simulate late transport delivery without throwing after reader cancellation.
            if (feed.cancelled) return;
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${++sequence}\nevent: toolcall\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          };
          for (const frame of backlog) feed.send({ ...frame, agentId: feed.agent });
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
  releaseEvidence?.();
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
});

describe("M5.06 follow geometry through default paired AgentPanel", () => {
  it("starts at newest-at-bottom and follows appended calls in chronological order", async () => {
    await mount();
    const viewport = scroller();
    await expect.poll(() => visible(23, viewport)).toBe(true);
    await append(24);
    await expect.poll(() => visible(24, viewport)).toBe(true);
    const paths = articles()
      .elements()
      .map((el) => el.textContent?.match(/call-(\d+)\.txt/)?.[1]);
    expect(paths).toEqual([...paths].sort());
    expect(paths.at(-1)).toBe("0024");
  });

  it("scrolling up preserves the read position on append; accessible Jump resumes follow", async () => {
    await mount();
    const viewport = await paused();
    const top = viewport.scrollTop;
    await append(24);
    expect(Math.abs(viewport.scrollTop - top)).toBeLessThanOrEqual(3);
    expect(visible(24, viewport)).toBe(false);
    await expect.element(jump(), { timeout: 800 }).toBeVisible();
    await jump().click();
    await expect.poll(() => visible(24, viewport)).toBe(true);
    await append(25);
    await expect.poll(() => visible(25, viewport)).toBe(true);
  });

  it("real F input toggles follow off and back on for the active panel", async () => {
    await mount();
    const viewport = await bottom();
    slot().element().focus();
    await userEvent.keyboard("f");
    const top = viewport.scrollTop;
    await append(24);
    expect(Math.abs(viewport.scrollTop - top)).toBeLessThanOrEqual(3);
    await expect.element(jump(), { timeout: 800 }).toBeVisible();
    await userEvent.keyboard("f");
    await expect.poll(() => visible(24, viewport)).toBe(true);
  });

  it.each(["input", "textarea", "contenteditable"])(
    "F does not steal %s input or resume paused follow",
    async (kind) => {
      await mount();
      const viewport = await paused();
      const field = document.createElement(kind === "contenteditable" ? "div" : kind);
      if (kind === "contenteditable") field.contentEditable = "true";
      field.style.position = "fixed";
      field.style.top = "0";
      document.body.append(field);
      try {
        field.focus();
        await userEvent.keyboard("f");
        expect("value" in field ? field.value : field.textContent).toBe("f");
        const top = viewport.scrollTop;
        await append(24);
        expect(Math.abs(viewport.scrollTop - top)).toBeLessThanOrEqual(3);
        expect(visible(24, viewport)).toBe(false);
        await expect.element(jump(), { timeout: 800 }).toBeVisible();
      } finally {
        field.remove();
      }
    },
  );

  it.each(["Control", "Meta", "Alt", "Shift", "repeat", "prevented"])(
    "ignores %s F while paused",
    async (kind) => {
      await mount();
      const viewport = await paused();
      slot().element().focus();
      if (kind === "repeat" || kind === "prevented") {
        const event = new KeyboardEvent("keydown", {
          key: "f",
          bubbles: true,
          cancelable: true,
          repeat: kind === "repeat",
        });
        if (kind === "prevented") event.preventDefault();
        slot().element().dispatchEvent(event);
      } else await userEvent.keyboard(`{${kind}>}f{/${kind}}`);
      await paint();
      const top = viewport.scrollTop;
      await append(24);
      expect(Math.abs(viewport.scrollTop - top)).toBeLessThanOrEqual(3);
      expect(visible(24, viewport)).toBe(false);
      await expect.element(jump(), { timeout: 800 }).toBeVisible();
    },
  );

  it.each(["agent", "project"])(
    "resets paused follow and scroll on %s change and cancels the old stream",
    async (kind) => {
      const { store, view } = await mount();
      await paused();
      const old = current();
      backlog = Array.from({ length: 24 }, (_, i) => call(i + 100));
      if (kind === "agent") await view.rerender(panel(store, B));
      else {
        selectProject("synthetic-next");
        seed(store, "synthetic-next");
      }
      await expect.poll(() => old.cancelled && old.signal?.aborted).toBe(true);
      await expect.poll(() => feeds.length).toBe(2);
      await paint();
      const viewport = scroller();
      await expect.poll(() => visible(123, viewport)).toBe(true);
      await paint();
      expect(card(999).elements()).toHaveLength(0);
      expect(card(23).elements()).toHaveLength(0);
      const next = current(
        kind === "agent" ? B : A,
        kind === "project" ? "synthetic-next" : PROJECT,
      );
      next.send(call(124, next.agent));
      await expect.poll(() => visible(124, viewport)).toBe(true);
      await view.unmount();
      await expect.poll(() => feeds.every((f) => f.cancelled && f.signal?.aborted)).toBe(true);
    },
  );

  it.each(["agent", "project"])(
    "rejects late evidence after %s changes even when transport ignores abort",
    async (kind) => {
      const { store, view } = await mount();
      current().send({
        ...call(23),
        evidence: { input: { id: "synthetic-held", status: "stored" }, output: null },
      });
      await expect.poll(() => releaseEvidence).toBeDefined();
      const old = current();
      if (kind === "agent") await view.rerender(panel(store, B));
      else {
        selectProject("synthetic-next");
        seed(store, "synthetic-next");
      }
      await expect
        .poll(() => old.cancelled && old.signal?.aborted && evidenceSignal?.aborted)
        .toBe(true);
      await expect.poll(() => feeds.length).toBe(2);
      releaseEvidence?.();
      await paint();
      expect(slot().element().textContent).not.toContain("SYNTHETIC STALE BODY");
      await view.unmount();
      await expect.poll(() => feeds.every((f) => f.cancelled && f.signal?.aborted)).toBe(true);
    },
  );

  it("updates a paired running call in place and cleans up on unmount", async () => {
    const { view } = await mount();
    const viewport = await bottom();
    current().send({ ...call(23), phase: "succeeded", durationMs: 37 });
    await expect.element(card(23)).toMatchTextContent("37 ms");
    expect(card(23).elements()).toHaveLength(1);
    expect(visible(23, viewport)).toBe(true);
    await view.unmount();
    await expect.poll(() => feeds.every((f) => f.cancelled && f.signal?.aborted)).toBe(true);
  });
});

async function large() {
  const store = createDataStore();
  seed(store);
  await render(
    <div data-testid="agent-panel-tab-slot" style={{ height: 360, width: 320, overflowY: "auto" }}>
      <LiveTab
        agentId={A}
        store={store}
        select={vi.fn()}
        calls={Array.from({ length: 1000 }, (_, i) => call(i))}
        evidence={{}}
      />
    </div>,
  );
  await paint();
  return scroller();
}
describe("synthetic 1000-call DOM rendering contract, not a capacity benchmark", () => {
  it("mounts at most 200 articles in a small viewport", async () => {
    await large();
    expect(articles().elements().length).toBeGreaterThan(0);
    expect(articles().elements().length).toBeLessThanOrEqual(200);
  });

  it("can traverse every supplied call in order, including first and last, with no invented body", async () => {
    const viewport = await large();
    await scroll(viewport, 0);
    await expect.poll(() => visible(0, viewport)).toBe(true);
    const seen = new Set<number>();
    let previousFirst = -1;
    for (let step = 0; step < 2000; step++) {
      const mounted = articles().elements();
      const indices = mounted.map((el) => {
        const matches = el.textContent?.match(/call-(\d+)\.txt/g) ?? [];
        const index = Number(matches[0]?.match(/\d+/)?.[0]);
        if (!seen.has(index)) {
          expect(matches).toHaveLength(1);
          expect(el.textContent).toContain("not reported");
          expect(el.querySelector("pre")?.textContent).toBe("not reported");
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(1000);
        }
        return index;
      });
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
      expect(indices[0]).toBeGreaterThanOrEqual(previousFirst);
      previousFirst = indices[0];
      for (const index of indices) {
        seen.add(index);
      }
      if (visible(999, viewport)) break;
      await scroll(
        viewport,
        Math.min(
          viewport.scrollHeight - viewport.clientHeight,
          viewport.scrollTop + viewport.clientHeight * 0.8,
        ),
      );
    }
    expect(visible(999, viewport)).toBe(true);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  }, 120_000);
});

it("preserves the paused reading anchor across variable-height expansion and an earlier output update", async () => {
  const store = createDataStore();
  seed(store);
  const calls = Array.from({ length: 40 }, (_, i) => ({
    ...call(i),
    toolName: "Bash",
    evidence: { input: null, output: { id: `synthetic-output-${i}`, status: "stored" as const } },
  }));
  const bodies: Record<string, EvidenceResponse> = Object.fromEntries(
    calls.map((frame, i) => {
      const id = `synthetic-output-${i}`;
      const text = JSON.stringify({
        stdout: Array.from({ length: 30 }, (_, n) => `synthetic-${i}-line-${n}`).join("\n"),
      });
      return [
        id,
        {
          id,
          projectId: PROJECT,
          toolCallId: frame.toolCallId,
          part: "output" as const,
          text,
          bytes: new TextEncoder().encode(text).length,
          masks: [],
          truncated: false,
        },
      ];
    }),
  );
  const tree = () => (
    <div data-testid="agent-panel-tab-slot" style={{ height: 420, width: 320, overflowY: "auto" }}>
      <LiveTab agentId={A} store={store} select={vi.fn()} calls={calls} evidence={bodies} />
    </div>
  );
  const view = await render(tree());
  await paint();
  const viewport = scroller();
  await scroll(viewport, 0);
  const before = card(0).element().getBoundingClientRect().top;
  await card(0).getByRole("button", { name: "Expand output" }).click();
  await paint();
  expect(Math.abs(card(0).element().getBoundingClientRect().top - before)).toBeLessThanOrEqual(3);
  expect(card(0).element().querySelector("pre")?.textContent).toContain("synthetic-0-line-0");
  // Scroll to an existing middle card, pause there, then change a row above that reading anchor.
  for (let step = 0; step < 100 && card(10).elements().length === 0; step++) {
    await scroll(viewport, viewport.scrollTop + viewport.clientHeight * 0.8);
  }
  card(10).element().scrollIntoView({ block: "start" });
  await paint();
  const anchor = card(10).element().getBoundingClientRect().top;
  const text = JSON.stringify({ stdout: "synthetic replacement with a shorter height" });
  bodies["synthetic-output-0"] = {
    ...bodies["synthetic-output-0"],
    text,
    bytes: new TextEncoder().encode(text).length,
  };
  await view.rerender(tree());
  await paint();
  expect(Math.abs(card(10).element().getBoundingClientRect().top - anchor)).toBeLessThanOrEqual(5);
  expect(visible(39, viewport)).toBe(false);
});

describe("follow is judged by distance from the bottom, not by the direction of a scroll change", () => {
  const stdout = (lines: number, tag: string) =>
    JSON.stringify({ stdout: Array.from({ length: lines }, (_, n) => `${tag}-${n}`).join("\n") });
  const bodyId = (n: number) => `synthetic-shrink-${n}`;
  function outputBody(n: number, text: string): EvidenceResponse {
    return {
      id: bodyId(n),
      projectId: PROJECT,
      toolCallId: `synthetic-call-${n}`,
      part: "output",
      text,
      bytes: new TextEncoder().encode(text).length,
      masks: [],
      truncated: false,
    };
  }
  const bashCall = (n: number): ToolCallFrame => ({
    ...call(n),
    toolName: "Bash",
    phase: "succeeded",
    evidence: { input: null, output: { id: bodyId(n), status: "stored" } },
  });
  type Bodies = Record<string, EvidenceResponse>;
  // Every card starts tall (ten captured lines each) so rows above the fold are mounted and measured.
  async function mountTall() {
    const store = createDataStore();
    seed(store);
    const frames = Array.from({ length: 40 }, (_, i) => bashCall(i));
    const bodies: Bodies = Object.fromEntries(
      frames.map((_, i) => [bodyId(i), outputBody(i, stdout(10, `tall-${i}`))]),
    );
    const tree = (list: readonly ToolCallFrame[], evidence: Bodies) => (
      <div
        data-testid="agent-panel-tab-slot"
        style={{ height: 420, width: 320, overflowY: "auto" }}
      >
        <LiveTab agentId={A} store={store} select={vi.fn()} calls={list} evidence={evidence} />
      </div>
    );
    const view = await render(tree(frames, bodies));
    await paint();
    const viewport = scroller();
    await scroll(viewport, viewport.scrollHeight);
    await expect.poll(() => visible(39, viewport)).toBe(true);
    return { frames, bodies, tree, view, viewport };
  }
  const gap = (viewport: HTMLElement) =>
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  /** Indices of mounted cards that lie wholly above the visible area. */
  function aboveFold(viewport: HTMLElement) {
    const clip = viewport.getBoundingClientRect();
    return articles()
      .elements()
      .filter((el) => el.getBoundingClientRect().bottom <= clip.top)
      .map((el) => Number(el.textContent?.match(/call-(\d+)\.txt/)?.[1]));
  }
  /** The bodies after the given rows shrink from ten captured lines to one. */
  function shrunk(bodies: Bodies, indices: readonly number[]): Bodies {
    const next = { ...bodies };
    for (const i of indices) next[bodyId(i)] = outputBody(i, stdout(1, `short-${i}`));
    return next;
  }

  it("keeps following when an already-measured row above the view shrinks in the commit that appends", async () => {
    const { frames, bodies, tree, view, viewport } = await mountTall();
    const above = aboveFold(viewport);
    // Precondition: there are mounted, measured rows above the visible area to shrink.
    expect(above.length).toBeGreaterThan(0);
    expect(gap(viewport)).toBeLessThanOrEqual(4);
    const evidence = { ...shrunk(bodies, above), [bodyId(40)]: outputBody(40, stdout(10, "t40")) };
    await view.rerender(tree([...frames, bashCall(40)], evidence));
    await paint();
    await expect.poll(() => visible(40, viewport)).toBe(true);
    expect(gap(viewport)).toBeLessThanOrEqual(4);
    expect(jump().elements()).toHaveLength(0);
    // Still following: the next append is visible too.
    await view.rerender(
      tree([...frames, bashCall(40), bashCall(41)], {
        ...evidence,
        [bodyId(41)]: outputBody(41, stdout(10, "t41")),
      }),
    );
    await paint();
    await expect.poll(() => visible(41, viewport)).toBe(true);
  });

  it("still pauses on a real scroll up, with the same shrink above and an append", async () => {
    const { frames, bodies, tree, view, viewport } = await mountTall();
    const above = aboveFold(viewport);
    expect(above.length).toBeGreaterThan(0);
    await scroll(viewport, viewport.scrollTop - viewport.clientHeight);
    expect(gap(viewport)).toBeGreaterThan(viewport.clientHeight / 2);
    await expect.element(jump(), { timeout: 800 }).toBeVisible();
    const evidence = { ...shrunk(bodies, above), [bodyId(40)]: outputBody(40, stdout(10, "t40")) };
    await view.rerender(tree([...frames, bashCall(40)], evidence));
    await paint();
    expect(visible(40, viewport)).toBe(false);
    // Rows above shrank, so the gap may shrink with them; it must stay well beyond a small threshold.
    expect(gap(viewport)).toBeGreaterThan(60);
    await expect.element(jump(), { timeout: 800 }).toBeVisible();
  });
});
