import "../styles/tokens.css";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { selectionStore } from "../city/interaction/selection.ts";
import { movementLabels } from "../city/movement/labels.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../data/project.ts";
import { dataStore } from "../data/store.ts";
import { SessionProvider } from "../pairing/session.tsx";
import { worldAnchors } from "./host/index.ts";
import { OverlayRoot } from "./index.tsx";

// W1.07 (issue #551): while agents walk and nothing changes in the store, OverlayRoot must not
// re-run its sidebar placement. placeSidebar reads the header and the root with
// getBoundingClientRect, so reads of the header rect count its runs. It may run once per real
// size change (ResizeObserver), never per frame of movement.

const AGENTS = 6;
const FRAMES = 30;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

beforeEach(() => {
  selectProject(DEFAULT_PROJECT_ID);
  selectionStore.select(null);
  // The sync loops park on requests that never answer, so no store event arrives.
  vi.stubGlobal(
    "fetch",
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (let i = 0; i < AGENTS; i++) worldAnchors.removeAnchor(`agent:agent-${i}`);
  selectionStore.select(null);
  movementLabels.set([]);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
});

describe("OverlayRoot while agents walk", () => {
  it("runs placeSidebar only when the header or sidebar size changes, and commits little", async () => {
    worldAnchors.setProjection(IDENTITY, { width: 800, height: 600 });
    for (let i = 0; i < AGENTS; i++)
      worldAnchors.setAnchor(`agent:agent-${i}`, [i / 10 - 0.3, 0, 0]);
    // Six walking agents, each with a label. Their rows are set once, before movement starts.
    movementLabels.set(
      Array.from({ length: AGENTS }, (_, i) => ({
        id: `agent-${i}`,
        name: `Agent ${i}`,
        status: "Working",
        onTheWay: true,
        state: "walking" as const,
        urgent: false,
      })),
    );
    let commits = 0;
    await render(
      <SessionProvider value="test-session">
        <Profiler
          id="overlay-root"
          onRender={(_id, phase) => {
            if (phase !== "mount") commits++;
          }}
        >
          <OverlayRoot />
        </Profiler>
      </SessionProvider>,
    );
    await expect.element(page.getByRole("status")).toBeVisible();
    const header = document.querySelector<HTMLElement>('[data-slot="header"]');
    expect(header).not.toBeNull();
    if (!header) return;
    // Settle: first layout, resize observers, fonts.
    for (let i = 0; i < 10; i++) await nextFrame();

    let headerRectReads = 0;
    const read = header.getBoundingClientRect.bind(header);
    header.getBoundingClientRect = () => {
      headerRectReads++;
      return read();
    };
    commits = 0;
    for (let frame = 0; frame < FRAMES; frame++) {
      await nextFrame();
      for (let i = 0; i < AGENTS; i++) {
        worldAnchors.setAnchor(`agent:agent-${i}`, [i / 10 - 0.3 + frame / 200, (i % 3) / 10, 0]);
      }
    }
    await nextFrame();
    const detail = `placeSidebar header reads=${headerRectReads}, OverlayRoot commits=${commits}, frames=${FRAMES}`;
    expect(headerRectReads, detail).toBe(0);
    expect(commits, detail).toBeLessThanOrEqual(2 * FRAMES);
  });
});
