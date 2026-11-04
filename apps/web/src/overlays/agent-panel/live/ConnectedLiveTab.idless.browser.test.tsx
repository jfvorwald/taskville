import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { ConnectedLiveTab } from "./ConnectedLiveTab.tsx";
import { AGENT, PROJECT, seedStore } from "./liveKit.tsx";

// M5.15 (#285) red round 2: one boundary event may produce several toolcall frames, and only the
// last carries `id:` (contracts/http-api.md, feed section). The client must apply an idless frame
// (it updates its call) but advance the reconnect cursor only on an identified frame, so a
// reconnect after an idless frame resumes from the previous id and the server replays the event.
const SECRET = "synthetic-idless-pairing";
interface Conn {
  url: URL;
  send: (id: number | undefined, data: ToolCallFrame) => void;
  end: () => void;
}
let conns: Conn[];

const path = (n: number) => `/synthetic/idless/call-${n}.txt`;
const frame = (n: number, phase: ToolCallFrame["phase"]): ToolCallFrame => ({
  toolCallId: `idless-call-${n}`,
  agentId: AGENT,
  toolName: "Write",
  phase,
  filePaths: [path(n)],
  evidence: { input: null, output: null },
});
const slot = () => page.getByTestId("agent-panel-tab-slot");
const card = (n: number) =>
  slot()
    .getByRole("article")
    .filter({ hasText: path(n) });
const after = (conn: Conn | undefined) => conn?.url.searchParams.get("after");
const LONG = { timeout: 8000 };

beforeEach(() => {
  conns = [];
  selectProject(PROJECT);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (!/^\/v1\/agents\/[^/]+\/feed$/.test(url.pathname))
      throw new Error(`Unexpected synthetic route ${url.pathname}`);
    const conn: Conn = { url, send: () => {}, end: () => {} };
    conns.push(conn);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          conn.send = (id, data) => {
            const head = id === undefined ? "" : `id: ${id}\n`;
            controller.enqueue(
              new TextEncoder().encode(`${head}event: toolcall\ndata: ${JSON.stringify(data)}\n\n`),
            );
          };
          conn.end = () => controller.close();
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

async function mount() {
  await render(
    <div data-testid="agent-panel-tab-slot" style={{ height: 460, width: 400, overflowY: "auto" }}>
      <SessionProvider value={SECRET}>
        <ConnectedLiveTab agentId={AGENT} store={seedStore()} select={vi.fn()} />
      </SessionProvider>
    </div>,
  );
  await expect.poll(() => conns.length).toBeGreaterThan(0);
}

describe("M5.15 ConnectedLiveTab: a boundary event's idless frames", () => {
  it("updates both calls to unfinished from an idless frame then the identified last frame", async () => {
    await mount();
    const [conn] = conns;
    conn?.send(5, frame(1, "running"));
    conn?.send(6, frame(2, "running"));
    await expect.element(card(2)).toMatchTextContent(/Status: running/);
    // One boundary event (id 7): the first closed call has no id, the last carries it.
    conn?.send(undefined, frame(1, "unfinished"));
    conn?.send(7, frame(2, "unfinished"));
    await expect.element(card(2)).toMatchTextContent(/Status: unfinished/);
    await expect.element(card(1)).toMatchTextContent(/Status: unfinished/);
    expect(slot().getByRole("article").elements()).toHaveLength(2);
  });

  it("advances the reconnect cursor only on the identified frame", async () => {
    await mount();
    const [conn] = conns;
    conn?.send(5, frame(1, "running"));
    conn?.send(6, frame(2, "running"));
    await expect.element(card(2)).toBeVisible();
    // The connection drops after the idless frame: resume from 6 so the server replays the event.
    conn?.send(undefined, frame(1, "unfinished"));
    await expect.element(card(1)).toMatchTextContent(/Status: unfinished/);
    conn?.end();
    await expect.poll(() => conns.length, LONG).toBe(2);
    expect(after(conns[1])).toBe("6");
    // The replay: both frames again, the last identified; the cursor moves to 7.
    conns[1]?.send(undefined, frame(1, "unfinished"));
    conns[1]?.send(7, frame(2, "unfinished"));
    await expect.element(card(2)).toMatchTextContent(/Status: unfinished/);
    conns[1]?.end();
    await expect.poll(() => conns.length, LONG).toBe(3);
    expect(after(conns[2])).toBe("7");
    expect(slot().getByRole("article").elements()).toHaveLength(2);
  });
});
