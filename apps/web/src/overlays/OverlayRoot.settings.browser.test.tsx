import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { selectionStore } from "../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../data/project.ts";
import { dataStore } from "../data/store.ts";
import { SessionProvider } from "../pairing/session.tsx";
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
  level: "needs_you",
  kind: "permission",
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
