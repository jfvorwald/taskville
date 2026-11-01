import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { LiveTab } from "./LiveTab.tsx";
import {
  AGENT,
  articles,
  build,
  type CallSpec,
  paint,
  renderConstrained,
  seedStore,
  slot,
} from "./liveKit.tsx";

// M5.06 round 5 item E: pins for behavior that is meant to hold already.
const write = (n: number): CallSpec => ({
  id: `pin-write-${n}`,
  tool: "Write",
  input: { file_path: `/r5/pin/file-${String(n).padStart(3, "0")}.txt`, content: `body ${n}` },
  filePaths: [`/r5/pin/file-${String(n).padStart(3, "0")}.txt`],
  durationMs: 1,
});
const list = (count: number) => Array.from({ length: count }, (_, i) => write(i));
const card = (n: number) =>
  articles().filter({ hasText: `file-${String(n).padStart(3, "0")}.txt` });
/** The card for call n is mounted and lies wholly inside the viewport. */
const onScreen = (viewport: Element, n: number) => {
  const element = card(n).elements()[0];
  if (!element) return false;
  const box = element.getBoundingClientRect();
  const clip = viewport.getBoundingClientRect();
  return box.top >= clip.top - 2 && box.bottom <= clip.bottom + 2;
};
const jump = () => page.getByRole("button", { name: /jump to latest/i });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("E: the Live tab cleans up what it installs on the scroller", () => {
  async function inHost(initialAnchor: string) {
    const host = document.createElement("div");
    host.dataset.testid = "agent-panel-tab-slot";
    host.style.cssText = "height: 420px; width: 400px; overflow-y: auto;";
    host.style.overflowAnchor = initialAnchor;
    document.body.append(host);
    const added: [string, EventListenerOrEventListenerObject, boolean][] = [];
    const removed: [string, EventListenerOrEventListenerObject, boolean][] = [];
    const capture = (options?: boolean | AddEventListenerOptions | EventListenerOptions) =>
      typeof options === "boolean" ? options : (options?.capture ?? false);
    const add = host.addEventListener.bind(host);
    const remove = host.removeEventListener.bind(host);
    host.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      o?: never,
    ) => {
      added.push([type, listener, capture(o)]);
      add(type, listener, o);
    }) as typeof host.addEventListener;
    host.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      o?: never,
    ) => {
      removed.push([type, listener, capture(o)]);
      remove(type, listener, o);
    }) as typeof host.removeEventListener;
    const store = seedStore();
    const { calls, evidence } = build(list(30));
    const view = await render(
      <LiveTab agentId={AGENT} store={store} select={vi.fn()} calls={calls} evidence={evidence} />,
      { container: host },
    );
    await paint();
    return { host, added, removed, view };
  }

  it("sets overflow-anchor none while mounted and restores the previous value on unmount", async () => {
    const { host, view } = await inHost("auto");
    expect(host.style.overflowAnchor).toBe("none");
    await view.unmount();
    expect(host.style.overflowAnchor).toBe("auto");
    host.remove();
  });

  it("restores an empty overflow-anchor to empty on unmount", async () => {
    const { host, view } = await inHost("");
    expect(host.style.overflowAnchor).toBe("none");
    await view.unmount();
    expect(host.style.overflowAnchor).toBe("");
    host.remove();
  });

  it("removes every scroll listener it added, including its capture-phase one, on unmount", async () => {
    const { host, added, removed, view } = await inHost("auto");
    // React binds its own root listeners (native bound functions) and never removes them.
    const ours = added.filter(
      ([type, listener]) => type === "scroll" && !String(listener).includes("[native code]"),
    );
    expect(ours.some(([, , captured]) => captured)).toBe(true);
    await view.unmount();
    const left = ours.filter(
      ([type, listener, captured]) =>
        !removed.some(([t, l, c]) => t === type && l === listener && c === captured),
    );
    expect(left.map(([type, , captured]) => `${type} capture=${captured}`)).toEqual([]);
    host.remove();
  });
});

describe("E: window mode, with no scrolling ancestor", () => {
  const inView = (el: Element | undefined) => {
    if (!el) return false;
    const box = el.getBoundingClientRect();
    return box.top >= -2 && box.bottom <= window.innerHeight + 2;
  };
  const newest = (n: number) =>
    articles()
      .elements()
      .find((el) => el.textContent?.includes(`file-${String(n).padStart(3, "0")}.txt`));
  const page_ = () => document.scrollingElement as HTMLElement;

  it("follows to the newest card, pauses on a real scroll up, and Jump to latest resumes", async () => {
    const store = seedStore();
    const tree = (count: number) => {
      const { calls, evidence } = build(list(count));
      return (
        <div data-testid="agent-panel-tab-slot">
          <LiveTab
            agentId={AGENT}
            store={store}
            select={vi.fn()}
            calls={calls}
            evidence={evidence}
          />
        </div>
      );
    };
    const view = await render(tree(30));
    await paint();
    // The page itself must scroll for this to be window mode.
    expect(page_().scrollHeight).toBeGreaterThan(window.innerHeight + 200);
    await expect.poll(() => inView(newest(29))).toBe(true);
    await view.rerender(tree(31));
    await expect.poll(() => inView(newest(30))).toBe(true);

    page_().scrollTop = Math.max(0, page_().scrollTop - window.innerHeight);
    await paint();
    await expect.element(jump(), { timeout: 800 }).toBeVisible();
    const top = page_().scrollTop;
    await view.rerender(tree(32));
    await paint();
    expect(Math.abs(page_().scrollTop - top)).toBeLessThanOrEqual(3);
    expect(inView(newest(31))).toBe(false);

    await jump().click();
    await expect.poll(() => inView(newest(31))).toBe(true);
    await view.rerender(tree(33));
    await expect.poll(() => inView(newest(32))).toBe(true);
    await view.unmount();
  });
});

describe("E: F is ignored inside a select and inside a dialog", () => {
  async function pausedPanel() {
    const panel = await renderConstrained(list(30));
    const viewport = slot().element();
    viewport.scrollTop = viewport.scrollHeight;
    await paint();
    viewport.scrollTop = Math.max(0, viewport.scrollTop - viewport.clientHeight);
    await paint();
    await expect.element(jump(), { timeout: 800 }).toBeVisible();
    return { ...panel, viewport };
  }

  it("does not toggle follow when focus is in a select", async () => {
    const { rerender, viewport } = await pausedPanel();
    const select = document.createElement("select");
    select.append(new Option("fox", "fox"), new Option("goat", "goat"));
    select.style.position = "fixed";
    select.style.top = "0";
    document.body.append(select);
    try {
      select.focus();
      await userEvent.keyboard("f");
      const top = viewport.scrollTop;
      await rerender(list(31));
      expect(Math.abs(viewport.scrollTop - top)).toBeLessThanOrEqual(3);
      expect(onScreen(viewport, 30)).toBe(false);
      await expect.element(jump(), { timeout: 800 }).toBeVisible();
    } finally {
      select.remove();
    }
  });

  it("does not toggle follow when focus is inside [role=dialog]", async () => {
    const { rerender, viewport } = await pausedPanel();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.style.position = "fixed";
    dialog.style.top = "0";
    const inner = document.createElement("button");
    inner.textContent = "inside";
    dialog.append(inner);
    document.body.append(dialog);
    try {
      inner.focus();
      await userEvent.keyboard("f");
      const top = viewport.scrollTop;
      await rerender(list(31));
      expect(Math.abs(viewport.scrollTop - top)).toBeLessThanOrEqual(3);
      expect(onScreen(viewport, 30)).toBe(false);
      await expect.element(jump(), { timeout: 800 }).toBeVisible();
    } finally {
      dialog.remove();
    }
  });
});
