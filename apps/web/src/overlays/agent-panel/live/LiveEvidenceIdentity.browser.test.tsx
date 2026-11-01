import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { ConnectedLiveTab } from "./ConnectedLiveTab.tsx";
import { AGENT, bodyOf, PROJECT, seedStore, turn } from "./liveKit.tsx";

// M5.06 pin round 6, confirm review: ConnectedLiveTab shows an evidence body only when it answers
// the request it was asked for. A body for another project, call or part is not shown.
const SECRET = "synthetic-identity-secret";
const CALL = "identity-bash-1";
const MARKER = "IDENTITY-STDOUT-MARKER";
const OUTPUT_ID = `${CALL}:output`;

let hits: string[];
let served: EvidenceResponse;
let sendFrame: (data: unknown) => void;

const frame: ToolCallFrame = {
  toolCallId: CALL,
  agentId: AGENT,
  toolName: "Bash",
  phase: "succeeded",
  filePaths: [],
  evidence: { input: null, output: { id: OUTPUT_ID, status: "stored" } },
};
const slot = () => page.getByTestId("agent-panel-tab-slot");
const cards = () => slot().getByRole("article");
const good = () => bodyOf(CALL, "output", JSON.stringify({ stdout: MARKER }));

beforeEach(() => {
  hits = [];
  selectProject(PROJECT);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.startsWith("/v1/evidence/")) {
      hits.push(decodeURIComponent(url.pathname.slice("/v1/evidence/".length)));
      return Response.json(served);
    }
    if (!/^\/v1\/agents\/[^/]+\/feed$/.test(url.pathname))
      throw new Error(`Unexpected synthetic route ${url.pathname}`);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          sendFrame = (data) =>
            init?.signal?.aborted ||
            controller.enqueue(
              new TextEncoder().encode(`id: 1\nevent: toolcall\ndata: ${JSON.stringify(data)}\n\n`),
            );
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
  const store = seedStore();
  await render(
    <div data-testid="agent-panel-tab-slot" style={{ height: 460, width: 400, overflowY: "auto" }}>
      <SessionProvider value={SECRET}>
        <ConnectedLiveTab agentId={AGENT} store={store} select={vi.fn()} />
      </SessionProvider>
    </div>,
  );
  await expect.poll(() => typeof sendFrame).toBe("function");
  sendFrame(frame);
  await expect.element(cards()).toBeVisible();
}

describe("M5.06 ConnectedLiveTab evidence identity", () => {
  it("shows a body whose identity matches the request (control)", async () => {
    served = good();
    await mount();
    await expect.element(cards()).toMatchTextContent(MARKER);
    expect(hits).toContain(OUTPUT_ID);
  });

  it.each([
    ["projectId", "some-other-project"],
    ["toolCallId", "some-other-call"],
    ["part", "input"],
  ] as const)("does not show a body with a mismatched %s", async (field, wrong) => {
    served = { ...good(), [field]: wrong } as EvidenceResponse;
    await mount();
    // The body was asked for and answered. Let any render of it happen before looking.
    await expect.poll(() => hits.length).toBeGreaterThan(0);
    await turn(300);
    expect(cards().element().textContent).not.toContain(MARKER);
    expect(cards().elements()).toHaveLength(1);
  });
});
