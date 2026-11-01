import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { selectionStore } from "../../../city/interaction/selection.ts";
import { initialState, type ProjectState } from "../../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { dataStore } from "../../../data/store.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { OverlayRoot } from "../../index.tsx";
import recorded from "./recorded-feed.fixture.json";

// Only fetch is replaced: the root, host, panel and (once composed) card are production code.
// No import from the absent action-card source. The recorded feed has real-route provenance.
const PROJECT = "spike";
const SESSION = "1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const AGENT = `claude-code:${SESSION}:afdf84bea07a9064c`;
const SECRET = "files-precedence-paired-session";
const REQUEST = "req-files-precedence";
const AT = "2026-10-31T12:01:00.000Z";
const NOTES = "/tmp/spike-s2/proj/notes.txt";
const COMMAND = "printf 'sidebar precedence exact input'";

interface Call {
  url: URL;
  headers: Headers;
  method: string;
}
let calls: Call[];

function projectState(): ProjectState {
  return {
    ...initialState(PROJECT),
    agents: {
      [AGENT]: {
        id: AGENT,
        sourceId: "claude-code",
        kind: "subagent",
        registered: true,
        connection: "connected",
        firstSeenAt: AT,
        lastSeenAt: AT,
        // Finished recorded work never races the wall-clock silence heuristic.
        finishedAt: AT,
        toolCallCount: 0,
        consecutiveToolFailures: 0,
      },
    },
    sessions: {
      [SESSION]: {
        id: SESSION,
        agentId: AGENT,
        sourceId: "claude-code",
        provenance: "live",
        firstSeenAt: AT,
        startSeq: 1,
        workingDirectory: "/tmp/spike-s2/proj",
        activity: { activity: "implementing", heuristic: false, since: AT },
      },
    },
  };
}

beforeEach(() => {
  calls = [];
  selectProject(PROJECT);
  selectionStore.select(null);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), location.origin), init);
    const url = new URL(request.url);
    calls.push({ url, headers: request.headers, method: request.method });
    if (decodeURIComponent(url.pathname) === `/v1/agents/${AGENT}/feed`) {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const frame of recorded.frames.filter((f) => f.data.agentId === AGENT)) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `id: ${frame.id}\nevent: toolcall\ndata: ${JSON.stringify(frame.data)}\n\n`,
                  ),
                );
              }
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    }
    if (url.pathname.startsWith("/v1/evidence/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
      const body = recorded.evidence[id as keyof typeof recorded.evidence];
      return Promise.resolve(body ? Response.json(body) : new Response(null, { status: 404 }));
    }
    if (url.pathname === `/v1/requests/${REQUEST}/input`) {
      return Promise.resolve(
        Response.json({
          requestId: REQUEST,
          projectId: PROJECT,
          sessionId: SESSION,
          toolName: "Bash",
          toolInput: { command: COMMAND },
          cwd: "/tmp/spike-s2/proj",
        }),
      );
    }
    // Park project/attention sync. Seed only once mounting has started these loops.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  });
});

afterEach(() => {
  selectionStore.select(null);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
  vi.unstubAllGlobals();
});

const sidebar = () => document.querySelector('[data-slot="sidebar"]');
const settings = () => page.getByRole("button", { name: "Settings", exact: true });
const row = () => page.getByTestId("file-row").filter({ hasText: NOTES });

describe("M5.07 production sidebar precedence", () => {
  it("gives needs-you the single sidebar ahead of Files, then restores panel and Settings", async () => {
    await render(
      <SessionProvider value={SECRET}>
        <OverlayRoot />
      </SessionProvider>,
    );
    await expect
      .poll(() => calls.some((c) => c.url.pathname === `/v1/projects/${PROJECT}/snapshot`))
      .toBe(true);
    const baseline = projectState();
    dataStore.getState().applySnapshotState(baseline);
    expect(dataStore.getState().attention).toEqual([]);
    await expect.element(settings()).toBeVisible();
    expect(sidebar()?.contains(settings().element())).toBe(true);

    selectionStore.select(AGENT);
    await expect.element(page.getByTestId("agent-panel")).toHaveAttribute("data-agent-id", AGENT);
    expect(settings().elements()).toHaveLength(0);
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect.element(row()).toHaveAttribute("data-edit-count", "1");
    await row().click();
    await expect.element(page.getByTestId("file-edits")).toMatchTextContent("BETA");
    const feed = calls.find(
      (c) => decodeURIComponent(c.url.pathname) === `/v1/agents/${AGENT}/feed`,
    );
    expect(feed?.url.searchParams.get("projectId")).toBe(PROJECT);
    expect(feed?.headers.get("X-Taskville-Session")).toBe(SECRET);

    // Same complete project/session/agent projection; only the held request changes.
    dataStore.getState().applySnapshotState({
      ...baseline,
      requests: {
        [REQUEST]: {
          id: REQUEST,
          agentId: AGENT,
          sessionId: SESSION,
          kind: "permission",
          toolName: "Bash",
          answerable: true,
          openedAt: AT,
          state: "open",
          late: false,
          mergedRequestIds: [],
        },
      },
    });
    expect(dataStore.getState().attention).toEqual([
      {
        agentId: AGENT,
        level: "needs_you",
        kind: "permission",
        since: AT,
        requestId: REQUEST,
        heuristic: false,
      },
    ]);
    expect(selectionStore.getSnapshot()).toBe(AGENT);
    // Expected red on M5.07: Files still owns the sidebar and this production card is absent.
    await expect
      .poll(() => ({
        card: sidebar()?.querySelector('[data-testid="action-card"]') !== null,
        panel: sidebar()?.querySelector('[data-testid="agent-panel"]') !== null,
        files: row().elements().length > 0,
        settings: settings().elements().length > 0,
      }))
      .toEqual({ card: true, panel: false, files: false, settings: false });
    await expect.element(page.getByTestId("action-card")).toBeVisible();
    expect(document.querySelectorAll('[data-slot="sidebar"]')).toHaveLength(1);
    expect(sidebar()?.contains(page.getByTestId("action-card").element())).toBe(true);
    expect(page.getByTestId("agent-panel").elements()).toHaveLength(0);
    expect(page.getByRole("tab", { name: "Files", exact: true }).elements()).toHaveLength(0);
    expect(settings().elements()).toHaveLength(0);
    await expect
      .poll(() => calls.find((c) => c.url.pathname === `/v1/requests/${REQUEST}/input`))
      .toBeDefined();
    const exact = calls.find((c) => c.url.pathname === `/v1/requests/${REQUEST}/input`);
    expect(exact?.method).toBe("GET");
    expect(exact?.url.searchParams.get("projectId")).toBe(PROJECT);
    expect(exact?.headers.get("X-Taskville-Session")).toBe(SECRET);
    await expect.element(page.getByTestId("action-card-input")).toMatchTextContent(COMMAND);

    dataStore.getState().applySnapshotState(baseline);
    expect(dataStore.getState().attention).toEqual([]);
    expect(selectionStore.getSnapshot()).toBe(AGENT);
    // M4 retains the final card until selection changes, even after a resnapshot drops the request.
    await expect.element(page.getByTestId("action-card")).toHaveAttribute("data-state", "closed");
    await expect.element(page.getByTestId("action-card")).toBeVisible();
    await expect
      .element(page.getByTestId("action-card"))
      .toMatchTextContent("This request is no longer open.");
    expect(sidebar()?.contains(page.getByTestId("action-card").element())).toBe(true);
    await expect
      .element(page.getByRole("button", { name: "Allow once", exact: true }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Open session", exact: true }))
      .toBeDisabled();
    expect(page.getByTestId("agent-panel").elements()).toHaveLength(0);
    expect(page.getByRole("tab", { name: "Files", exact: true }).elements()).toHaveLength(0);
    expect(row().elements()).toHaveLength(0);
    expect(settings().elements()).toHaveLength(0);

    selectionStore.select(null);
    await expect.element(page.getByTestId("action-card")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("agent-panel")).not.toBeInTheDocument();
    await expect.element(settings()).toBeVisible();
    expect(sidebar()?.contains(settings().element())).toBe(true);

    selectionStore.select(AGENT);
    await expect.element(page.getByTestId("agent-panel")).toHaveAttribute("data-agent-id", AGENT);
    expect(page.getByTestId("action-card").elements()).toHaveLength(0);
    expect(settings().elements()).toHaveLength(0);
    // Default tab persistence across a remount is not contracted. Select Files again.
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect.element(row()).toBeVisible();
    selectionStore.select(null);
    await expect.element(page.getByTestId("agent-panel")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("action-card")).not.toBeInTheDocument();
    await expect.element(settings()).toBeVisible();
    expect(sidebar()?.contains(settings().element())).toBe(true);
    expect(calls.filter((c) => c.url.pathname.startsWith("/v1/commands"))).toHaveLength(0);
  });
});
