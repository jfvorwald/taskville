import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AgentPanel } from "../../../overlays/agent-panel/shell/AgentPanel.tsx";
import { createAnchorSource } from "../../../overlays/host/anchors.ts";
import type { OverlayProps } from "../../../overlays/host/types.ts";
import { message } from "./envelopeFixtures.ts";
import { ENVELOPE_FLIGHT_MS } from "./envelopes.ts";
import { FRAME_WAIT, mount } from "./testScene.tsx";

// M5.04 red round 3: a clicked envelope selects the sender and the panel shows its Live tab, even
// when the panel was not mounted at the click. There is no card scroll or focus token (descoped).
// The real scene and a real click make the request; the panel then mounts afterwards over the same
// store, selection and feed hand-off, and renders a stub tab body so no feed is needed.

const slot = () => page.getByTestId("agent-panel-tab-slot");

function props(selectedId: string): OverlayProps {
  return {
    mode: "live",
    selection: { selectedId, select: vi.fn() },
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    anchors: createAnchorSource(),
    intents: { available: true, run: vi.fn() },
    settings: { get: (_key, fallback) => fallback, set: vi.fn() },
  };
}

const paint = async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};
const tab = () => slot().element().getAttribute("data-tab");
const shownAgent = () => page.getByTestId("agent-panel").element().getAttribute("data-agent-id");

type Click = Awaited<ReturnType<typeof clickEnvelope>>;

/** A real click on an in-flight envelope with no panel mounted; the scene is gone afterwards. */
async function clickEnvelope() {
  const scene = await mount();
  scene.store.getState().applyEvent(message("pip", "bo", "hi bo"));
  scene.clock.now = ENVELOPE_FLIGHT_MS / 2;
  await vi.waitFor(() => expect(scene.envelopes()).toHaveLength(1), FRAME_WAIT);
  await scene.frames(3);
  await userEvent.click(scene.root().gl.domElement, {
    position: scene.onCanvas(scene.envelopes()[0] as never),
  });
  await vi.waitFor(() => expect(scene.selection.getSnapshot()).toBe("pip"), FRAME_WAIT);
  const { store, feedFocus } = scene;
  await scene.unmount();
  return { store, feedFocus, sender: "pip" };
}

const panelFor = (c: Click, selectedId: string) => (
  <AgentPanel
    {...props(selectedId)}
    store={c.store}
    feedFocus={c.feedFocus}
    initialTab="files"
    renderTab={(t, id) => <div>{`${t}:${id}`}</div>}
  />
);

/** Mounts the panel after the click, waits for Live, then the viewer picks Files. */
async function liveThenFiles(c: Click) {
  const view = await render(panelFor(c, c.sender));
  await vi.waitFor(() => expect(tab()).toBe("live"), FRAME_WAIT);
  await page.getByRole("tab", { name: "Files" }).click();
  await vi.waitFor(() => expect(tab()).toBe("files"), FRAME_WAIT);
  return view;
}

afterEach(() => vi.useRealTimers());

describe("a clicked envelope and the agent panel", () => {
  it("opens the sender's Live tab when the panel mounts after the click, and carries nothing to the next agent", async () => {
    const c = await clickEnvelope();
    const view = await liveThenFiles(c);
    await view.rerender(panelFor(c, "bo"));
    await vi.waitFor(() => expect(shownAgent()).toBe("bo"), FRAME_WAIT);
    expect(tab()).toBe("files");
  }, 60_000);

  it("uses a request once: rerendering, or coming back to the sender, keeps the viewer's tab", async () => {
    const c = await clickEnvelope();
    const view = await liveThenFiles(c);
    await view.rerender(panelFor(c, c.sender));
    await paint();
    expect(tab()).toBe("files");

    await view.rerender(panelFor(c, "bo"));
    await vi.waitFor(() => expect(shownAgent()).toBe("bo"), FRAME_WAIT);
    await view.rerender(panelFor(c, c.sender));
    await vi.waitFor(() => expect(shownAgent()).toBe(c.sender), FRAME_WAIT);
    await paint();
    expect(tab()).toBe("files");
  }, 60_000);

  it("does not re-apply a used request when the panel is unmounted and mounted again", async () => {
    const c = await clickEnvelope();
    const view = await liveThenFiles(c);
    await view.unmount();

    await render(panelFor(c, c.sender));
    await vi.waitFor(() => expect(shownAgent()).toBe(c.sender), FRAME_WAIT);
    await paint();
    // The panel's own default for a fresh mount, not the old click.
    expect(tab()).toBe("files");
  }, 60_000);

  it("ignores a request that has waited more than a few seconds when the panel mounts", async () => {
    const c = await clickEnvelope();
    vi.useFakeTimers({ toFake: ["Date", "performance"], now: Date.now() + 60_000 });
    await render(panelFor(c, c.sender));
    await vi.waitFor(() => expect(shownAgent()).toBe(c.sender), FRAME_WAIT);
    await paint();
    expect(tab()).toBe("files");
  }, 60_000);
});
