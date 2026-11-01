import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { initialState } from "../../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { createDataStore } from "../../../data/store.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayMode, OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";
import recorded from "./recorded-feed.fixture.json";

// Production shell/transport boundary, reusing the route-verified recorded fixture.
const edit = recorded.frames.find(
  (frame) => frame.data.toolName === "Edit" && frame.data.phase === "succeeded",
);
if (!edit) throw new Error("recorded completed Edit missing");
const A = edit.data.agentId;
const PATH = edit.data.filePaths[0];
const inputId = edit.data.evidence.input?.id;
if (!inputId) throw new Error("recorded Edit input missing");
const body = recorded.evidence[inputId as keyof typeof recorded.evidence];
const SECRET = "files-history-test-session";
const sent = vi.fn();
const props = (mode: OverlayMode): OverlayProps => ({
  mode,
  selectors: {
    counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
  },
  selection: { selectedId: A, select: () => {} },
  anchors: createAnchorSource(),
  intents: { available: false, run: sent },
  settings: { get: (_key, fallback) => fallback, set: () => {} },
});
function store() {
  const data = createDataStore();
  data.getState().reset("spike");
  data.getState().applySnapshotState({
    ...initialState("spike"),
    agents: {
      [A]: {
        id: A,
        sourceId: "claude-code",
        kind: "subagent",
        registered: true,
        connection: "connected",
        toolCallCount: 0,
        consecutiveToolFailures: 0,
        firstSeenAt: "2026-10-31T12:00:00Z",
        lastSeenAt: "2026-10-31T12:01:00Z",
      },
    },
  });
  return data;
}

// Catch the known render failure so the red assertion reports its cause without an
// uncaught browser error leaking into another case. A successful render never uses this fallback.
class RenderBoundary extends Component<
  { children: ReactNode; errors: Error[] },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error) {
    this.props.errors.push(error);
  }
  override render() {
    return this.state.failed ? <p role="alert">Panel failed to render</p> : this.props.children;
  }
}
interface Read {
  url: URL;
  signal: AbortSignal | null;
}
let reads: Read[];
let cancelled: boolean;
let send: ((frame: { id: number; data: unknown }) => void) | undefined;
let release: (() => void) | undefined;
let holdInput: boolean;
const turn = () => new Promise((resolve) => setTimeout(resolve, 50));
const slot = () => page.getByTestId("agent-panel-tab-slot");
const row = () => page.getByTestId("file-row").filter({ hasText: PATH });
async function honestHistory() {
  await expect.element(page.getByTestId("agent-panel")).toHaveAttribute("data-readonly", "true");
  await expect.element(slot()).toHaveAttribute("data-tab", "files");
  // Contract is semantic: unavailable history is explicit, never an empty list claiming no edits.
  await expect
    .element(slot())
    .toMatchTextContent(/unavailable|not reported|not available|not recorded/i);
  expect(page.getByTestId("file-row").elements()).toHaveLength(0);
  expect(page.getByTestId("file-edits").elements()).toHaveLength(0);
  expect(sent).not.toHaveBeenCalled();
}
beforeEach(() => {
  reads = [];
  cancelled = false;
  send = undefined;
  release = undefined;
  holdInput = false;
  sent.mockClear();
  selectProject("spike");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin);
    reads.push({ url, signal: init?.signal ?? null });
    if (url.pathname.endsWith("/feed")) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            send = (frame) =>
              controller.enqueue(
                new TextEncoder().encode(
                  `id: ${frame.id}\nevent: toolcall\ndata: ${JSON.stringify(frame.data)}\n\n`,
                ),
              );
            for (const frame of recorded.frames.filter((frame) => frame.data.agentId === A))
              send(frame);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
    const evidence = recorded.evidence[id as keyof typeof recorded.evidence];
    if (holdInput && id === inputId)
      return new Promise<Response>((resolve) => {
        // Ignore abort deliberately: the panel must fence a transport's late result too.
        release = () => resolve(Response.json(body));
      });
    return evidence ? Response.json(evidence) : new Response(null, { status: 404 });
  });
});
afterEach(() => {
  release?.();
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
});

describe("M5.07 history Files mounting", () => {
  it("opens honest read-only Files without SessionProvider or a command service", async () => {
    const errors: Error[] = [];
    await render(
      <RenderBoundary errors={errors}>
        <AgentPanel {...props("history")} store={store()} />
      </RenderBoundary>,
    );
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await turn();
    expect(errors.map((error) => error.message)).toEqual([]);
    await honestHistory();
    expect(reads).toEqual([]);
  });

  it("never reads live feed or evidence in history even when paired", async () => {
    await render(
      <SessionProvider value={SECRET}>
        <AgentPanel {...props("history")} store={store()} />
      </SessionProvider>,
    );
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await turn();
    expect(reads.map((read) => read.url.pathname)).toEqual([]);
    await honestHistory();
  });

  it("cancels live reads on a mode switch and fences late evidence and feed input", async () => {
    holdInput = true;
    const data = store();
    const panel = (mode: OverlayMode) => (
      <SessionProvider value={SECRET}>
        <AgentPanel {...props(mode)} store={data} />
      </SessionProvider>
    );
    const view = await render(panel("live"));
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect.element(row()).toBeVisible();
    await row().click();
    await expect.poll(() => release !== undefined).toBe(true);
    const previousReads = [...reads];
    expect(previousReads.some((read) => read.url.pathname.endsWith("/feed"))).toBe(true);
    expect(previousReads.some((read) => read.url.pathname.endsWith(inputId))).toBe(true);
    await view.rerender(panel("history"));
    await turn();
    expect.soft(previousReads.every((read) => read.signal?.aborted)).toBe(true);
    expect.soft(cancelled).toBe(true);
    release?.();
    // A cancelled stream cannot enqueue; an incorrectly retained live stream can.
    if (!cancelled) send?.({ ...edit, id: 1000 });
    await turn();
    expect.soft(slot().element().textContent).not.toContain(body.text);
    // Longer than the existing feed reconnect delay: history must not restart live reads.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect.soft(reads).toHaveLength(previousReads.length);
    await honestHistory();
  });

  it("allows controlled historical Files without pairing or transport", async () => {
    await render(
      <AgentPanel
        {...props("history")}
        store={store()}
        renderTab={(tab, agentId) =>
          tab === "files" ? <p>{`Recorded history for ${agentId}`}</p> : null
        }
      />,
    );
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect.element(slot()).toHaveTextContent(`Recorded history for ${A}`);
    expect(reads).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
  });

  it("keeps default live Files connected and displays selected recorded evidence", async () => {
    await render(
      <SessionProvider value={SECRET}>
        <AgentPanel {...props("live")} store={store()} />
      </SessionProvider>,
    );
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect.element(row()).toBeVisible();
    await row().click();
    await expect
      .poll(() => page.getByTestId("file-edits").element().querySelector("pre")?.textContent)
      .toBe(body.text);
    expect(reads.some((read) => read.url.pathname.endsWith("/feed"))).toBe(true);
    expect(reads.some((read) => read.url.pathname.endsWith(inputId))).toBe(true);
  });
});
