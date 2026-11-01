import "../styles/tokens.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { selectionStore } from "../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../data/project.ts";
import { dataStore } from "../data/store.ts";
import { SessionProvider } from "../pairing/session.tsx";
import { themeController } from "../themes/core/index.ts";
import { OverlayRoot } from "./index.tsx";

// M5.19 (issue #315): the Settings toggle is always available. The web smoke "a theme switch
// changes the theme and keeps agents, selection and camera" selects an agent and then looks for
// the Settings button, which the sidebar precedence (action card, then agent panel, then
// settings) took away.
//
// CTO decision pinned here, through the real OverlayRoot:
//   - The button named "Settings" is present whatever the selection is (no agent, an agent, an
//     agent with a needs-you card).
//   - Opening Settings is an explicit choice: while it is open the single sidebar shows Settings
//     (the Theme group), not the agent panel and not the action card.
//   - Closing Settings (the same button, aria-expanded back to false) returns the sidebar to
//     whichever card or panel applies to the current selection, which is unchanged throughout.
//   - A needs-you request that arrives or exists while Settings is open is still announced: the
//     header counts it. Nothing is hidden silently.
//
// Not pinned: where the toggle lives in the DOM (inside the sidebar or beside it), and the
// tab title and chime, which do not depend on the sidebar.
//
// The sync loops are parked on requests that never answer (as in OverlayRoot.wiring) and the
// store is seeded after they started, because starting a loop resets the store.

const SINCE = new Date(Date.now() - 30_000).toISOString();

let urls: string[] = [];

beforeEach(() => {
  urls = [];
  selectProject(DEFAULT_PROJECT_ID);
  selectionStore.select(null);
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    urls.push(String(input));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
  selectionStore.select(null);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
});

const agent = (id: string, displayName: string) => ({
  id,
  sourceId: "claude-code",
  kind: "session",
  displayName,
  registered: true,
  connection: "connected",
  firstSeenAt: SINCE,
  lastSeenAt: SINCE,
  toolCallCount: 0,
  consecutiveToolFailures: 0,
  registeredSeq: 1,
});

const needsYou = (agentId: string, requestId: string) => ({
  agentId,
  level: "needs_you" as const,
  kind: "permission" as const,
  since: SINCE,
  requestId,
  heuristic: false,
});

const request = (id: string, agentId: string) => ({
  id,
  agentId,
  sessionId: "sess-1",
  kind: "permission",
  toolName: "Bash",
  answerable: true,
  openedAt: SINCE,
  state: "open",
  late: false,
  mergedRequestIds: [],
});

/** a1 "Ada" has no request; a2 "Bo" is the agent the tests select unless they say otherwise. */
function seed(needing: readonly string[] = []) {
  const agents = { a1: agent("a1", "Ada"), a2: agent("a2", "Bo") };
  dataStore.setState({
    agents: Object.values(agents) as never,
    attention: needing.map((id) => needsYou(id, `req-${id}`)),
    counts: { needsYou: needing.length, trouble: 0, waiting: 0 },
    state: {
      agents,
      teams: {},
      activity: {},
      toolCalls: {},
      requests: Object.fromEntries(needing.map((id) => [`req-${id}`, request(`req-${id}`, id)])),
    } as never,
  });
}

async function mountSeeded(needing: readonly string[] = []) {
  await render(
    <SessionProvider value="test-session">
      <OverlayRoot />
    </SessionProvider>,
  );
  await vi.waitFor(() => expect(urls).toContain("/v1/projects/unsorted/snapshot"));
  seed(needing);
}

const toggle = () => page.getByRole("button", { name: "Settings", exact: true });
const sidebar = () => document.querySelector('[data-slot="sidebar"]');
const agentPanel = () => document.querySelector('[data-testid="agent-panel"]');
const actionCard = () => document.querySelector('[data-testid="action-card"]');
/** The header's counts line (the action card has a status element of its own). */
const counts = () => page.getByRole("status", { name: /need/ });
/** The settings body is in the sidebar: its Theme group is there and the toggle is expanded. */
const settingsShown = () => sidebar()?.textContent?.includes("Theme") === true;

describe("OverlayRoot: Settings stays reachable while an agent is selected (M5.19)", () => {
  it("shows the Settings toggle with an agent selected, and opening it puts Settings in the sidebar", async () => {
    await mountSeeded();
    selectionStore.select("a2");
    await vi.waitFor(() => expect(agentPanel()).not.toBeNull());

    await expect.element(toggle()).toBeVisible();
    await toggle().click();

    await expect.element(toggle()).toHaveAttribute("aria-expanded", "true");
    await vi.waitFor(() => expect(settingsShown()).toBe(true));
    // Opening Settings takes the sidebar from the agent panel, and leaves the selection alone.
    expect(agentPanel()).toBeNull();
    expect(selectionStore.getSnapshot()).toBe("a2");
  });

  it("returns the agent panel for the same selection when Settings is closed", async () => {
    await mountSeeded();
    selectionStore.select("a2");
    await vi.waitFor(() => expect(agentPanel()).not.toBeNull());
    await toggle().click();
    await vi.waitFor(() => expect(settingsShown()).toBe(true));

    await toggle().click();

    await expect.element(toggle()).toHaveAttribute("aria-expanded", "false");
    await vi.waitFor(() => expect(agentPanel()).not.toBeNull());
    expect(agentPanel()?.getAttribute("data-agent-id")).toBe("a2");
    expect(settingsShown()).toBe(false);
    expect(selectionStore.getSnapshot()).toBe("a2");
  });

  it("opens Settings over a needs-you action card, still counts the request in the header, and returns to the card on close", async () => {
    await mountSeeded(["a1"]);
    selectionStore.select("a1");
    await vi.waitFor(() => expect(actionCard()).not.toBeNull());

    await expect.element(toggle()).toBeVisible();
    await toggle().click();

    await vi.waitFor(() => expect(settingsShown()).toBe(true));
    expect(actionCard()).toBeNull();
    // Nothing is hidden silently: the header still counts the request behind the open Settings.
    await expect.element(counts()).toMatchTextContent("1 needs you");
    expect(selectionStore.getSnapshot()).toBe("a1");

    await toggle().click();

    await vi.waitFor(() => expect(actionCard()).not.toBeNull());
    expect(settingsShown()).toBe(false);
    await expect.element(counts()).toMatchTextContent("1 needs you");
  });

  it("announces a needs-you request that arrives while Settings is open, and shows its card once Settings is closed", async () => {
    await mountSeeded();
    selectionStore.select("a2");
    await vi.waitFor(() => expect(agentPanel()).not.toBeNull());
    await toggle().click();
    await vi.waitFor(() => expect(settingsShown()).toBe(true));
    await expect.element(counts()).toMatchTextContent("0 need you");

    seed(["a2"]);

    await expect.element(counts()).toMatchTextContent("1 needs you");
    // Settings was an explicit choice, so the arrival does not take the sidebar from it.
    expect(settingsShown()).toBe(true);
    expect(actionCard()).toBeNull();

    await toggle().click();
    await vi.waitFor(() => expect(actionCard()).not.toBeNull());
    expect(settingsShown()).toBe(false);
  });

  it("keeps keyboard focus on the replacement Settings toggle when opening and closing", async () => {
    await mountSeeded();
    selectionStore.select("a2");
    await vi.waitFor(() => expect(agentPanel()).not.toBeNull());
    const floating = toggle().element();

    // Reach the floating control through the browser's real tab order, then activate it.
    for (let tabs = 0; document.activeElement !== floating && tabs < 30; tabs++) {
      await userEvent.keyboard("{Tab}");
    }
    await expect.element(floating).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    await expect.element(toggle()).toHaveAttribute("aria-expanded", "true");
    const panelToggle = toggle().element();
    expect(panelToggle).not.toBe(floating);
    expect(sidebar()?.contains(panelToggle)).toBe(true);
    await expect.element(panelToggle).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);

    await userEvent.keyboard("{Enter}");

    await expect.element(toggle()).toHaveAttribute("aria-expanded", "false");
    await vi.waitFor(() => expect(agentPanel()).not.toBeNull());
    const restored = toggle().element();
    expect(restored).not.toBe(panelToggle);
    expect(sidebar()?.contains(restored)).toBe(false);
    await expect.element(restored).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(selectionStore.getSnapshot()).toBe("a2");
  });

  it.each([320, 500, 768, 1024])(
    "keeps the floating Settings toggle reachable without overlapping counts or camera controls at %dpx",
    async (width) => {
      // Match main.tsx's global CSS and ThemedCity's token publication without mounting WebGL.
      const root = document.documentElement;
      const rootAttributes = ["style", "data-theme", "data-mode", "data-history"].map(
        (name) => [name, root.getAttribute(name)] as const,
      );
      const detach = themeController.attach(document.documentElement);
      const restore = { width: window.innerWidth, height: window.innerHeight };
      try {
        await page.viewport(width, 640);
        await mountSeeded(["a1"]);
        selectionStore.select("a2");
        await vi.waitFor(() => expect(agentPanel()).not.toBeNull());
        await expect.element(counts()).toMatchTextContent("1 needs you");
        await expect.element(toggle()).toBeVisible();

        const button = toggle().element();
        const buttonBox = button.getBoundingClientRect();
        const countsBox = counts().element().getBoundingClientRect();
        expect(window.innerWidth).toBe(width);
        expect(buttonBox.width).toBeGreaterThan(0);
        expect(buttonBox.height).toBeGreaterThan(0);
        expect(buttonBox.left).toBeGreaterThanOrEqual(0);
        expect(buttonBox.right).toBeLessThanOrEqual(window.innerWidth);
        expect(buttonBox.top).toBeGreaterThanOrEqual(0);
        expect(buttonBox.bottom).toBeLessThanOrEqual(window.innerHeight);
        expect(countsBox.width).toBeGreaterThan(0);
        expect(countsBox.height).toBeGreaterThan(0);
        const overlaps =
          buttonBox.left < countsBox.right &&
          buttonBox.right > countsBox.left &&
          buttonBox.top < countsBox.bottom &&
          buttonBox.bottom > countsBox.top;
        expect(overlaps).toBe(false);
        // Counts and camera controls share the centered header. At 320px the camera buttons,
        // rather than the counts, occupy the floating toggle's old position.
        const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true }).element();
        const zoomBox = zoomIn.getBoundingClientRect();
        const zoomHit = document.elementFromPoint(
          zoomBox.left + zoomBox.width / 2,
          zoomBox.top + zoomBox.height / 2,
        );
        expect(zoomIn.contains(zoomHit), zoomHit?.outerHTML).toBe(true);
        for (const control of page
          .getByRole("group", { name: "Camera", exact: true })
          .element()
          .querySelectorAll("button")) {
          const box = control.getBoundingClientRect();
          expect(
            buttonBox.left < box.right &&
              buttonBox.right > box.left &&
              buttonBox.top < box.bottom &&
              buttonBox.bottom > box.top,
            JSON.stringify({
              control: control.getAttribute("aria-label") ?? control.textContent,
              button: buttonBox.toJSON(),
              camera: box.toJSON(),
            }),
          ).toBe(false);
        }
        expect(
          button.contains(
            document.elementFromPoint(
              buttonBox.left + buttonBox.width / 2,
              buttonBox.top + buttonBox.height / 2,
            ),
          ),
        ).toBe(true);
        await toggle().click();
        await vi.waitFor(() => expect(settingsShown()).toBe(true));
      } finally {
        detach();
        for (const [name, value] of rootAttributes) {
          if (value === null) root.removeAttribute(name);
          else root.setAttribute(name, value);
        }
        await page.viewport(restore.width, restore.height);
      }
    },
  );

  it("is unchanged with nothing selected: the toggle is there, closed, and opens Settings in the sidebar", async () => {
    await mountSeeded();

    await expect.element(toggle()).toBeVisible();
    await expect.element(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(settingsShown()).toBe(false);
    expect(sidebar()?.textContent).toContain("Settings");
    expect(agentPanel()).toBeNull();
    expect(actionCard()).toBeNull();

    await toggle().click();
    await expect.element(toggle()).toHaveAttribute("aria-expanded", "true");
    await vi.waitFor(() => expect(settingsShown()).toBe(true));

    await toggle().click();
    await expect.element(toggle()).toHaveAttribute("aria-expanded", "false");
    await vi.waitFor(() => expect(settingsShown()).toBe(false));
  });
});
