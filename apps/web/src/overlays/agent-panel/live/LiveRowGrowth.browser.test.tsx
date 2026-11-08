import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { initialState } from "../../../data/domain.ts";
import { createDataStore } from "../../../data/store.ts";
import { LiveTab } from "./LiveTab.tsx";
import { openDetails } from "./liveKit.tsx";

// M10.01: a mounted row whose own content grows (late highlighting, an evidence body arriving, a
// disclosure opening) must be re-measured. The growth below is applied straight to the DOM, so
// LiveFeed does not re-render, exactly as when a child component updates itself.
// Entire recording is synthetic.
const A = "synthetic-growth-agent";
const PROJECT = "synthetic-growth";
const path = (n: number) => `/synthetic/growth/call-${String(n).padStart(4, "0")}.txt`;
const call = (n: number): ToolCallFrame => ({
  toolCallId: `synthetic-call-${n}`,
  agentId: A,
  toolName: "Write",
  phase: "succeeded",
  filePaths: [path(n)],
  evidence: { input: null, output: null },
});
const paint = async () => {
  for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
};
const GROWTH = 160;

async function mount(count = 60, extra: Partial<React.ComponentProps<typeof LiveTab>> = {}) {
  const store = createDataStore();
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState({
    ...initialState(PROJECT),
    agents: {
      [A]: {
        id: A,
        sourceId: "claude-code",
        kind: "session" as const,
        displayName: A,
        registered: true,
        connection: "connected" as const,
        toolCallCount: 0,
        consecutiveToolFailures: 0,
        firstSeenAt: "2026-11-01T00:00:00Z",
        lastSeenAt: "2026-11-01T00:00:00Z",
      },
    },
  });
  const calls = Array.from({ length: count }, (_, i) => call(i));
  const result = await render(
    <div data-testid="growth-slot" style={{ height: 420, width: 360, overflowY: "auto" }}>
      <LiveTab agentId={A} store={store} select={vi.fn()} calls={calls} evidence={{}} {...extra} />
    </div>,
  );
  await paint();
  return result;
}
const viewport = () =>
  document.querySelector<HTMLElement>('[data-testid="growth-slot"]') as HTMLElement;
const rowEls = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="feed"] > [data-index]')).sort(
    (a, b) => Number(a.dataset.index) - Number(b.dataset.index),
  );
const row = (index: number) => rowEls().find((el) => Number(el.dataset.index) === index);
const top = (index: number) => row(index)?.getBoundingClientRect().top ?? Number.NaN;
const gap = () => {
  const v = viewport();
  return v.scrollHeight - v.clientHeight - v.scrollTop;
};
async function scrollTo(value: number) {
  viewport().scrollTop = value;
  await paint();
}
/** Grow a mounted row's content without any React render. */
async function grow(index: number, by = GROWTH) {
  const target = row(index)?.querySelector("article");
  if (!target) throw new Error(`row ${index} is not mounted`);
  const spacer = document.createElement("div");
  spacer.dataset.testGrowth = "1";
  spacer.style.height = `${by}px`;
  target.append(spacer);
  await paint();
}
function overlaps() {
  const els = rowEls();
  const bad: string[] = [];
  for (let i = 1; i < els.length; i++) {
    const a = els[i - 1].getBoundingClientRect();
    const b = els[i].getBoundingClientRect();
    if (
      Number(els[i].dataset.index) === Number(els[i - 1].dataset.index) + 1 &&
      a.bottom > b.top + 1
    )
      bad.push(`${els[i - 1].dataset.index}/${els[i].dataset.index} by ${a.bottom - b.top}px`);
  }
  return bad;
}
/** Index of the first row that is at least partly in view, and its top relative to the viewport. */
function firstVisible() {
  const clip = viewport().getBoundingClientRect();
  const el = rowEls().find((r) => r.getBoundingClientRect().bottom > clip.top + 1);
  if (!el) throw new Error("no visible row");
  const index = Number(el.dataset.index);
  return { index, offset: el.getBoundingClientRect().top - clip.top };
}

afterEach(() => {
  for (const el of document.querySelectorAll("[data-test-growth]")) el.remove();
});

describe("M10.01 feed rows never overlap after their own content grows", () => {
  it("moves later rows down and leaves no overlapping boxes", async () => {
    await mount();
    await scrollTo(0);
    expect(overlaps()).toEqual([]);
    expect(row(3)).toBeDefined();
    const before = top(3);
    await grow(1);
    await expect.poll(() => overlaps(), { timeout: 1000 }).toEqual([]);
    expect(top(3) - before).toBeGreaterThanOrEqual(GROWTH - 2);
  });

  it("re-measures rows that were mounted with the first paint, before any scroll", async () => {
    await mount(8);
    expect(row(2)).toBeDefined();
    expect(overlaps()).toEqual([]);
    const before = top(4);
    await grow(2);
    await expect.poll(() => overlaps(), { timeout: 1000 }).toEqual([]);
    expect(top(4) - before).toBeGreaterThanOrEqual(GROWTH - 2 - Math.max(0, viewport().scrollTop));
  });

  it("keeps rows apart when several rows grow, one after another", async () => {
    await mount();
    await scrollTo(0);
    for (const index of [0, 2, 1]) await grow(index, 90);
    await expect.poll(() => overlaps(), { timeout: 1000 }).toEqual([]);
  });

  it("stays pinned to the bottom in follow mode when the newest row grows", async () => {
    await mount();
    await scrollTo(viewport().scrollHeight);
    expect(gap()).toBeLessThanOrEqual(4);
    const last = Math.max(...rowEls().map((el) => Number(el.dataset.index)));
    expect(last).toBe(59);
    await grow(last);
    await expect.poll(() => gap(), { timeout: 1000 }).toBeLessThanOrEqual(4);
    expect(overlaps()).toEqual([]);
  });

  it("stays pinned to the bottom in follow mode when a row above the newest grows", async () => {
    await mount();
    await scrollTo(viewport().scrollHeight);
    await grow(58);
    await expect.poll(() => gap(), { timeout: 1000 }).toBeLessThanOrEqual(4);
    expect(overlaps()).toEqual([]);
  });

  it("keeps a reader's first visible row in place when a row below it grows", async () => {
    await mount();
    await scrollTo(viewport().scrollHeight);
    await scrollTo(viewport().scrollTop - viewport().clientHeight * 3);
    const anchor = firstVisible();
    const below = anchor.index + 2;
    expect(row(below)).toBeDefined();
    await grow(below);
    expect(Math.abs(firstVisible().offset - anchor.offset)).toBeLessThanOrEqual(4);
    expect(firstVisible().index).toBe(anchor.index);
    await expect.poll(() => overlaps(), { timeout: 1000 }).toEqual([]);
  });

  it("keeps a reader's first visible row in place when a row above it grows", async () => {
    await mount();
    await scrollTo(viewport().scrollHeight);
    await scrollTo(viewport().scrollTop - viewport().clientHeight * 3);
    const anchor = firstVisible();
    const above = anchor.index - 1;
    expect(row(above)).toBeDefined();
    await grow(above);
    await expect.poll(() => overlaps(), { timeout: 1000 }).toEqual([]);
    const after = firstVisible();
    expect(after.index).toBe(anchor.index);
    expect(Math.abs(after.offset - anchor.offset)).toBeLessThanOrEqual(4);
  });
});

/**
 * Check the rows in every frame at the point the frame paints them. A frame runs rAF callbacks,
 * then layout, then ResizeObserver callbacks in the order the observers were created, then paints.
 * A probe observer created in this frame's rAF is the newest, so its first callback runs after the
 * feed's own observers have reacted to this frame's layout: it sees what the frame paints.
 */
function watchFrames() {
  const seen: string[] = [];
  let on = true;
  const tick = () => {
    if (!on) return;
    const probe = new ResizeObserver(() => {
      probe.disconnect();
      seen.push(...overlaps());
    });
    probe.observe(document.documentElement);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop: () => {
      on = false;
      return seen;
    },
  };
}

/** A feed whose evidence bodies a test can deliver later, from outside React's act scope. */
function LateBodies(props: {
  store: ReturnType<typeof createDataStore>;
  calls: ToolCallFrame[];
  onSetter: (set: (next: Record<string, EvidenceResponse>) => void) => void;
}) {
  const [evidence, set] = useState<Record<string, EvidenceResponse>>({});
  props.onSetter(set);
  return (
    <div data-testid="growth-slot" style={{ height: 420, width: 360, overflowY: "auto" }}>
      <LiveTab
        agentId={A}
        store={props.store}
        select={vi.fn()}
        calls={props.calls}
        evidence={evidence}
      />
    </div>
  );
}

describe("M10.01 rows that grow in a later React commit", () => {
  // The real-app case: rows mount before their evidence bodies arrive, are measured, then the
  // bodies render in a later commit. No painted frame may show the stale offsets.
  it("never paints a frame with overlapping rows when evidence bodies arrive", async () => {
    const store = createDataStore();
    store.getState().reset(PROJECT);
    const frames = Array.from({ length: 3 }, (_, i) => ({
      ...call(i),
      evidence: { input: { id: `synthetic-body-${i}`, status: "stored" as const }, output: null },
    }));
    const text = JSON.stringify({
      content: Array.from({ length: 10 }, (_, n) => `synthetic line ${n}`).join("\n"),
    });
    const bodies = Object.fromEntries(
      frames.map((frame, i) => [
        `synthetic-body-${i}`,
        {
          id: `synthetic-body-${i}`,
          projectId: PROJECT,
          toolCallId: frame.toolCallId,
          part: "input",
          text,
          bytes: new TextEncoder().encode(text).length,
          masks: [],
          truncated: false,
        } satisfies EvidenceResponse,
      ]),
    );
    let setEvidence: ((next: Record<string, EvidenceResponse>) => void) | undefined;
    await render(
      <LateBodies
        store={store}
        calls={frames}
        onSetter={(set) => {
          setEvidence = set;
        }}
      />,
    );
    await paint();
    expect(rowEls()).toHaveLength(3);
    expect(overlaps()).toEqual([]);
    const before = row(0)?.getBoundingClientRect().height ?? 0;
    const watch = watchFrames();
    // Outside act, as a fetch completion is: React schedules the render as the app would. Inside
    // act the ResizeObserver's follow-up render would be flushed before paint and hide the frame.
    setEvidence?.(bodies);
    await paint();
    expect((row(0)?.getBoundingClientRect().height ?? 0) - before).toBeGreaterThan(60);
    expect(watch.stop()).toEqual([]);
    expect(overlaps()).toEqual([]);
  });
});

describe("M10.01 a late highlighter swap inside an expanded card", () => {
  it("re-measures the row so the next row never sits under the taller code", async () => {
    const id = "synthetic-growth-input";
    const text = JSON.stringify({ content: "plain" });
    const body: EvidenceResponse = {
      id,
      projectId: PROJECT,
      toolCallId: "synthetic-call-0",
      part: "input",
      text,
      bytes: new TextEncoder().encode(text).length,
      masks: [],
      truncated: false,
    };
    let finish: (() => void) | undefined;
    const highlighter = {
      loadCount: 0,
      highlight: (source: string) =>
        new Promise<{ content: string }[][]>((resolve) => {
          finish = () =>
            resolve(
              source
                .split("\n")
                .flatMap((line) =>
                  Array.from({ length: 12 }, (_, n) => [{ content: `${line} ${n}` }]),
                ),
            );
        }),
    };
    const store = createDataStore();
    store.getState().reset(PROJECT);
    const frames = Array.from({ length: 6 }, (_, i) => ({
      ...call(i),
      evidence:
        i === 0
          ? { input: { id, status: "stored" as const }, output: null }
          : { input: null, output: null },
    }));
    await render(
      <div data-testid="growth-slot" style={{ height: 420, width: 360, overflowY: "auto" }}>
        <LiveTab
          agentId={A}
          store={store}
          select={vi.fn()}
          calls={frames}
          evidence={{ [id]: body }}
          highlighter={highlighter}
        />
      </div>,
    );
    await paint();
    await scrollTo(0);
    // M10.02: the code Expand control lives inside Details.
    await openDetails(page.getByRole("article").first());
    await page
      .getByRole("button", { name: /^Expand Write / })
      .first()
      .click();
    await paint();
    await expect.poll(() => finish).toBeDefined();
    const before = row(0)?.getBoundingClientRect().height ?? 0;
    finish?.();
    await expect.poll(() => row(0)?.querySelectorAll("pre span").length ?? 0).toBeGreaterThan(5);
    await paint();
    await expect.poll(() => overlaps(), { timeout: 1000 }).toEqual([]);
    expect((row(0)?.getBoundingClientRect().height ?? 0) - before).toBeGreaterThan(20);
    expect(top(1)).toBeGreaterThanOrEqual(row(0)?.getBoundingClientRect().bottom ?? 0 - 1);
  });
});
