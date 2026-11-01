import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { selectionStore } from "../../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { OverlayRoot } from "../index.tsx";

// M4.07, lesson L-127 (a prop default that falls back hides missing wiring): the card works with
// injected props in ActionCard.browser.test.tsx; this mounts the real OverlayRoot and checks the
// pieces are connected. Selecting a needs-you agent must put the action card in the single
// sidebar slot (ahead of the settings panel) and ask the engine for the exact input with the
// paired session; selecting nobody must leave the card out.
//
// The sync loops are parked on requests that never answer (as in OverlayRoot.wiring), and the
// store is seeded after they have started because starting a loop resets the store.

const SINCE = new Date(Date.now() - 30_000).toISOString();

let calls: { url: string; init: RequestInit | undefined }[] = [];

beforeEach(() => {
  calls = [];
  selectProject(DEFAULT_PROJECT_ID);
  selectionStore.select(null);
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("/v1/requests/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            requestId: "req-1",
            projectId: DEFAULT_PROJECT_ID,
            sessionId: "sess-1",
            toolName: "Bash",
            toolInput: { command: "npm test" },
            cwd: "/work/app",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
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

const card = () => document.querySelector('[data-testid="action-card"]');

async function mountSeeded() {
  await render(
    <SessionProvider value="test-session">
      <OverlayRoot />
    </SessionProvider>,
  );
  await vi.waitFor(() =>
    expect(calls.map((c) => c.url)).toContain("/v1/projects/unsorted/snapshot"),
  );
  dataStore.setState({
    attention: [
      {
        agentId: "a1",
        level: "needs_you",
        kind: "permission",
        since: SINCE,
        requestId: "req-1",
        heuristic: false,
      },
    ],
    state: {
      agents: { a1: { id: "a1", displayName: "Ada" } },
      requests: {
        "req-1": {
          id: "req-1",
          agentId: "a1",
          sessionId: "sess-1",
          kind: "permission",
          toolName: "Bash",
          answerable: true,
          openedAt: SINCE,
          state: "open",
          late: false,
          mergedRequestIds: [],
        },
      },
    } as never,
  });
}

describe("OverlayRoot wiring: action card", () => {
  it("is left out while no agent is selected", async () => {
    await mountSeeded();
    await new Promise((r) => setTimeout(r, 100));
    expect(card()).toBeNull();
  });

  it("opens in the sidebar when a needs-you agent is selected, and loads its exact input with the paired session", async () => {
    await mountSeeded();
    selectionStore.select("a1");
    await vi.waitFor(() => expect(card()).not.toBeNull());
    expect(card()?.closest('[data-slot="sidebar"]')).not.toBeNull();
    await vi.waitFor(() =>
      expect(calls.some((c) => c.url === "/v1/requests/req-1/input?projectId=unsorted")).toBe(true),
    );
    const call = calls.find((c) => c.url.startsWith("/v1/requests/req-1/input"));
    expect(new Headers(call?.init?.headers).get("X-Taskville-Session")).toBe("test-session");
  });

  // Code review 6: the card and the settings panel share the one sidebar. The panel holds it
  // whenever the card is not up, and gets it back once the selection is cleared.
  it("keeps the settings panel in the sidebar while nothing is selected, and returns it after the card closes", async () => {
    const sidebar = () => document.querySelector('[data-slot="sidebar"]');
    await mountSeeded();
    await vi.waitFor(() => expect(sidebar()?.textContent).toContain("Settings"));
    expect(card()).toBeNull();

    selectionStore.select("a1");
    await vi.waitFor(() => expect(card()).not.toBeNull());
    expect(sidebar()?.textContent).not.toContain("Settings");

    selectionStore.select(null);
    await vi.waitFor(() => expect(card()).toBeNull());
    await vi.waitFor(() => expect(sidebar()?.textContent).toContain("Settings"));
  });

  it("gives the sidebar back when the selection is cleared", async () => {
    await mountSeeded();
    selectionStore.select("a1");
    await vi.waitFor(() => expect(card()).not.toBeNull());
    selectionStore.select(null);
    await vi.waitFor(() => expect(card()).toBeNull());
  });
});
