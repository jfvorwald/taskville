import { describe, expect, it, vi } from "vitest";
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

describe("a clicked envelope and the agent panel", () => {
  it("opens the sender's Live tab when the panel mounts after the click, and carries nothing to the next agent", async () => {
    const scene = await mount();
    const { store, feedFocus } = scene;
    scene.store.getState().applyEvent(message("pip", "bo", "hi bo"));
    scene.clock.now = ENVELOPE_FLIGHT_MS / 2;
    await vi.waitFor(() => expect(scene.envelopes()).toHaveLength(1), FRAME_WAIT);
    await scene.frames(3);
    await userEvent.click(scene.root().gl.domElement, {
      position: scene.onCanvas(scene.envelopes()[0] as never),
    });
    await vi.waitFor(() => expect(scene.selection.getSnapshot()).toBe("pip"), FRAME_WAIT);
    const sender = scene.selection.getSnapshot() as string;
    await scene.unmount();

    // The panel did not exist at the click. It mounts now, on a different tab by its own default.
    const view = await render(
      <AgentPanel
        {...props(sender)}
        store={store}
        feedFocus={feedFocus}
        initialTab="files"
        renderTab={(tab, id) => <div>{`${tab}:${id}`}</div>}
      />,
    );
    await vi.waitFor(
      () => expect(slot().element().getAttribute("data-tab")).toBe("live"),
      FRAME_WAIT,
    );

    // The viewer moves to Files; selecting another agent must not drag them back to Live.
    await page.getByRole("tab", { name: "Files" }).click();
    await vi.waitFor(
      () => expect(slot().element().getAttribute("data-tab")).toBe("files"),
      FRAME_WAIT,
    );
    await view.rerender(
      <AgentPanel
        {...props("bo")}
        store={store}
        feedFocus={feedFocus}
        initialTab="files"
        renderTab={(tab, id) => <div>{`${tab}:${id}`}</div>}
      />,
    );
    await vi.waitFor(
      () =>
        expect(page.getByTestId("agent-panel").element().getAttribute("data-agent-id")).toBe("bo"),
      FRAME_WAIT,
    );
    expect(slot().element().getAttribute("data-tab")).toBe("files");
  }, 60_000);
});
