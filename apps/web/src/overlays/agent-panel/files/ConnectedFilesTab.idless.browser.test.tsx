import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { ConnectedFilesTab } from "./ConnectedFilesTab.tsx";

// M5.15 (#285) red round 2: the Files tab's feed client with a boundary event's idless frame.
// Same contract as the Live tab: apply the idless frame, advance the cursor only on an identified
// one.
const SECRET = "synthetic-files-idless";
const AGENT = "files-idless-agent";
const PATH = "/synthetic/idless/notes.txt";
interface Conn {
  url: URL;
  send: (id: number | undefined, data: ToolCallFrame) => void;
  end: () => void;
}
let conns: Conn[];

const frame = (n: number, phase: ToolCallFrame["phase"]): ToolCallFrame => ({
  toolCallId: `files-idless-${n}`,
  agentId: AGENT,
  toolName: "Write",
  phase,
  filePaths: [PATH],
  evidence: { input: null, output: null },
});
const heading = (n: number) =>
  document.querySelector(`[data-tool-call-id="files-idless-${n}"] h4`)?.textContent ?? null;
const after = (conn: Conn | undefined) => conn?.url.searchParams.get("after");
const LONG = { timeout: 8000 };

beforeEach(() => {
  conns = [];
  selectProject("files-idless");
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
    <SessionProvider value={SECRET}>
      <ConnectedFilesTab agentId={AGENT} />
    </SessionProvider>,
  );
  await expect.poll(() => conns.length).toBeGreaterThan(0);
}

describe("M5.15 ConnectedFilesTab: a boundary event's idless frames", () => {
  it("updates both calls to unfinished from an idless frame then the identified last frame", async () => {
    await mount();
    const [conn] = conns;
    conn?.send(5, frame(1, "running"));
    conn?.send(6, frame(2, "running"));
    await page.getByTestId("file-row").filter({ hasText: PATH }).click();
    await expect.poll(() => heading(2)).toBe("Write: running");
    conn?.send(undefined, frame(1, "unfinished"));
    conn?.send(7, frame(2, "unfinished"));
    await expect.poll(() => heading(2)).toBe("Write: unfinished");
    await expect.poll(() => heading(1)).toBe("Write: unfinished");
  });

  it("advances the reconnect cursor only on the identified frame", async () => {
    await mount();
    const [conn] = conns;
    conn?.send(5, frame(1, "running"));
    conn?.send(6, frame(2, "running"));
    await page.getByTestId("file-row").filter({ hasText: PATH }).click();
    await expect.poll(() => heading(2)).toBe("Write: running");
    conn?.send(undefined, frame(1, "unfinished"));
    await expect.poll(() => heading(1)).toBe("Write: unfinished");
    conn?.end();
    await expect.poll(() => conns.length, LONG).toBe(2);
    expect(after(conns[1])).toBe("6");
    conns[1]?.send(undefined, frame(1, "unfinished"));
    conns[1]?.send(7, frame(2, "unfinished"));
    await expect.poll(() => heading(2)).toBe("Write: unfinished");
    conns[1]?.end();
    await expect.poll(() => conns.length, LONG).toBe(3);
    expect(after(conns[2])).toBe("7");
  });
});
