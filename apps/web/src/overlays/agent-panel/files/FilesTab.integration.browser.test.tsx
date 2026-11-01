import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { selectionStore } from "../../../city/interaction/selection.ts";
import { initialState } from "../../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { createDataStore, type DataStore, dataStore } from "../../../data/store.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { OverlayRoot } from "../../index.tsx";
import { AgentPanel } from "../shell/AgentPanel.tsx";
import recorded from "./recorded-feed.fixture.json";

// Production boundary: no renderTab override and no frames/evidence passed to FilesTab.
// The wire fixture is independently checked against real M5.01 routes by recorded-feed.test.ts.
// Fetch is the existing browser transport seam. Unrelated OverlayRoot sync requests stay parked.
const A = "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5:afdf84bea07a9064c";
const B = "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5:a0b4668e13e056653";
const NOTES = "/tmp/spike-s2/proj/notes.txt";
const HELLO = "/tmp/spike-s2/proj/hello.txt";
const SECRET = "files-test-paired-session";
const bodies = recorded.evidence;
const aInput = recorded.frames.find((f) => f.data.agentId === A && f.data.toolName === "Edit")?.data
  .evidence.input?.id;
if (!aInput) throw new Error("fixture Edit input missing");

interface RequestRecord {
  url: URL;
  headers: Headers;
  signal: AbortSignal | null;
}
interface Feed extends RequestRecord {
  cancelled: boolean;
}
let requests: RequestRecord[];
let feeds: Feed[];
let holdInput: boolean;
let releaseInput: (() => void) | undefined;

function seed(store: DataStore, project = "spike") {
  store.getState().reset(project);
  store.getState().applySnapshotState({
    ...initialState(project),
    agents: Object.fromEntries(
      [A, B].map((id) => [
        id,
        {
          id,
          sourceId: "claude-code",
          kind: "subagent" as const,
          registered: true,
          connection: "connected" as const,
          toolCallCount: 0,
          consecutiveToolFailures: 0,
          firstSeenAt: "2026-10-31T12:00:00Z",
          lastSeenAt: "2026-10-31T12:01:00Z",
        },
      ]),
    ),
  });
}
function props(selectedId: string): OverlayProps {
  return {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_key, fallback) => fallback, set: () => {} },
  };
}
const row = (path: string) => page.getByTestId("file-row").filter({ hasText: path });
const feedFor = (agent: string, project = "spike") =>
  feeds.find(
    (f) =>
      decodeURIComponent(f.url.pathname) === `/v1/agents/${agent}/feed` &&
      f.url.searchParams.get("projectId") === project,
  );
const evidenceRequests = () => requests.filter((r) => r.url.pathname.startsWith("/v1/evidence/"));

beforeEach(() => {
  requests = [];
  feeds = [];
  holdInput = false;
  releaseInput = undefined;
  selectProject("spike");
  selectionStore.select(null);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), location.origin), init);
    const entry = {
      url: new URL(request.url),
      headers: request.headers,
      signal: init?.signal ?? null,
    };
    requests.push(entry);
    if (/^\/v1\/agents\/[^/]+\/feed$/.test(entry.url.pathname)) {
      const feed = { ...entry, cancelled: false };
      feeds.push(feed);
      const agent = decodeURIComponent(entry.url.pathname.split("/")[3] ?? "");
      const frames =
        entry.url.searchParams.get("projectId") === "spike"
          ? recorded.frames.filter((f) => f.data.agentId === agent)
          : [];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                frames
                  .map((f) => `id: ${f.id}\nevent: toolcall\ndata: ${JSON.stringify(f.data)}\n\n`)
                  .join(""),
              ),
            );
          },
          cancel() {
            feed.cancelled = true;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (entry.url.pathname.startsWith("/v1/evidence/")) {
      const id = decodeURIComponent(entry.url.pathname.slice("/v1/evidence/".length));
      const body = bodies[id as keyof typeof bodies];
      if (!body) return new Response(null, { status: 404 });
      if (holdInput && id === aInput) {
        // Deliberately deliver after abort: cleanup must also guard against late responses.
        return new Promise<Response>((resolve) => {
          releaseInput = () => resolve(Response.json(body));
        });
      }
      return Response.json(body);
    }
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
  releaseInput?.();
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
  selectionStore.select(null);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
});

describe("M5.07 production Files integration", () => {
  it("fills the default Files slot from the paired selected-project feed and evidence routes", async () => {
    const store = createDataStore();
    seed(store);
    const view = await render(
      <SessionProvider value={SECRET}>
        <AgentPanel {...props(A)} store={store} />
      </SessionProvider>,
    );
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect.poll(() => feedFor(A), { timeout: 2000 }).toBeDefined();
    await expect.element(row(NOTES)).toHaveAttribute("data-edit-count", "1");
    expect(row(HELLO).elements()).toHaveLength(0);
    await row(NOTES).click();
    await expect.element(page.getByTestId("file-edits")).toMatchTextContent("beta");
    await expect.element(page.getByTestId("file-edits")).toMatchTextContent("BETA");
    expect(evidenceRequests().length).toBeGreaterThan(0);
    for (const req of [...feeds, ...evidenceRequests()]) {
      expect(req.headers.get("X-Taskville-Session")).toBe(SECRET);
    }
    await view.unmount();
    await expect.poll(() => feeds.every((f) => f.signal?.aborted && f.cancelled)).toBe(true);
  });

  it("cancels old agent and project work, clears detail, and ignores late evidence", async () => {
    holdInput = true;
    const store = createDataStore();
    seed(store);
    const panel = (id: string) => (
      <SessionProvider value={SECRET}>
        <AgentPanel {...props(id)} store={store} />
      </SessionProvider>
    );
    const view = await render(panel(A));
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect.poll(() => feedFor(A), { timeout: 2000 }).toBeDefined();
    await row(NOTES).click();
    await expect.poll(() => releaseInput).toBeDefined();
    const oldEvidence = evidenceRequests().find((r) => r.url.pathname.endsWith(aInput));
    expect(oldEvidence).toBeDefined();
    await view.rerender(panel(B));
    await expect.poll(() => feedFor(B)).toBeDefined();
    await expect.poll(() => feedFor(A)?.signal?.aborted && feedFor(A)?.cancelled).toBe(true);
    expect(oldEvidence?.signal?.aborted).toBe(true);
    await expect.element(row(HELLO)).toBeVisible();
    expect(row(NOTES).elements()).toHaveLength(0);
    expect(page.getByTestId("file-edits").elements()).toHaveLength(0);
    await row(HELLO).click();
    await expect.element(page.getByTestId("file-edits")).toMatchTextContent("hello from B");
    releaseInput?.();
    // Drain the late response and its React update before checking the current evidence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect.element(page.getByTestId("file-edits")).not.toMatchTextContent("BETA");
    expect(
      Array.from(
        page.getByTestId("file-edits").element().querySelectorAll("[data-tool-call-id]"),
        (e) => e.getAttribute("data-tool-call-id"),
      ),
    ).toEqual(["toolu_012456Qp8BNCL1oE2LoMK9x5"]);
    selectProject("beta");
    seed(store, "beta");
    // Same agent identity in another project must still discard the old feed and open detail.
    await expect.poll(() => feedFor(B, "beta")).toBeDefined();
    await expect.poll(() => feedFor(B)?.signal?.aborted && feedFor(B)?.cancelled).toBe(true);
    await expect.element(page.getByText(/no files.*reported/i)).toBeVisible();
    expect(page.getByTestId("file-row").elements()).toHaveLength(0);
    expect(page.getByTestId("file-edits").elements()).toHaveLength(0);
    await view.unmount();
  });

  it("reaches Files through OverlayRoot selection and restores the existing settings sidebar on close", async () => {
    await render(
      <SessionProvider value={SECRET}>
        <OverlayRoot />
      </SessionProvider>,
    );
    await expect
      .poll(() => requests.some((r) => r.url.pathname === "/v1/projects/spike/snapshot"))
      .toBe(true);
    seed(dataStore);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect
      .element(page.getByRole("radiogroup", { name: "Theme", exact: true }))
      .toBeVisible();
    selectionStore.select(A);
    await expect
      .element(page.getByTestId("agent-panel"), { timeout: 2000 })
      .toHaveAttribute("data-agent-id", A);
    expect(page.getByRole("radiogroup", { name: "Theme", exact: true }).elements()).toHaveLength(0);
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect.element(row(NOTES)).toBeVisible();
    await row(NOTES).click();
    await expect.element(page.getByTestId("file-edits")).toMatchTextContent("BETA");
    selectionStore.select(null);
    await expect.element(page.getByTestId("agent-panel")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    // Action-card arbitration remains pending PR #294: no action-card source exists here.
  });
});
