import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { ConnectedLiveTab } from "./ConnectedLiveTab.tsx";
import { AGENT, PROJECT, seedStore } from "./liveKit.tsx";

// M5.06 pin round 6 for d0dd2c4's secret-free React key: the pairing secret is no part of any key.
// A new secret restarts the stream with the new header and clears what the old one showed.
const FIRST = "synthetic-secret-first";
const SECOND = "synthetic-secret-second";
const SESSION = "X-Taskville-Session";

interface Open {
  url: URL;
  secret: string | null;
  signal: AbortSignal | null | undefined;
  send: (id: number, data: unknown) => void;
}
let opened: Open[];

const frame = (n: number): ToolCallFrame => ({
  toolCallId: `secret-call-${n}`,
  agentId: AGENT,
  toolName: "Write",
  phase: "succeeded",
  filePaths: [`/synthetic/secret/call-${n}.txt`],
  evidence: { input: null, output: null },
});
const slot = () => page.getByTestId("agent-panel-tab-slot");
const cards = () => slot().getByRole("article");

beforeEach(() => {
  opened = [];
  selectProject(PROJECT);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin);
    if (!/^\/v1\/agents\/[^/]+\/feed$/.test(url.pathname))
      throw new Error(`Unexpected synthetic route ${url.pathname}`);
    const headers = new Headers(init?.headers);
    const request: Open = {
      url,
      secret: headers.get(SESSION),
      signal: init?.signal,
      send: () => {},
    };
    opened.push(request);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          request.send = (id, data) => {
            if (init?.signal?.aborted) return;
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${id}\nevent: toolcall\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          };
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
});

describe("M5.06 the session secret restarts the stream", () => {
  it("a changed secret opens a new stream with the new header, ends the old, and clears old cards", async () => {
    const store = seedStore();
    const tree = (secret: string) => (
      <div
        data-testid="agent-panel-tab-slot"
        style={{ height: 460, width: 400, overflowY: "auto" }}
      >
        <SessionProvider value={secret}>
          <ConnectedLiveTab agentId={AGENT} store={store} select={vi.fn()} />
        </SessionProvider>
      </div>
    );
    const view = await render(tree(FIRST));
    await expect.poll(() => opened.length).toBe(1);
    expect(opened[0].secret).toBe(FIRST);
    opened[0].send(1, frame(1));
    await expect.element(cards().filter({ hasText: "call-1.txt" })).toBeVisible();

    await view.rerender(tree(SECOND));

    // A new stream request is made, from the start, with the new secret.
    await expect.poll(() => opened.length).toBe(2);
    expect(opened[1].secret).toBe(SECOND);
    expect(opened[1].url.searchParams.get("after")).toBe("0");
    expect(opened[1].url.searchParams.get("projectId")).toBe(PROJECT);
    expect(opened[1].url.pathname).toBe(opened[0].url.pathname);
    // The old stream is ended, so nothing is left running under the old secret.
    expect(opened[0].signal?.aborted).toBe(true);
    expect(opened[1].signal?.aborted).toBe(false);
    // What the old stream showed is gone, before the new stream has said anything.
    await expect.poll(() => cards().elements().length).toBe(0);
    expect(slot().element().textContent).not.toContain("call-1.txt");

    // The new stream works and its calls show.
    opened[1].send(1, frame(2));
    await expect.element(cards().filter({ hasText: "call-2.txt" })).toBeVisible();
    expect(cards().elements()).toHaveLength(1);
    expect(opened).toHaveLength(2);
  });
});
