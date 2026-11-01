import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { initialState } from "../../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { createDataStore, type DataStore } from "../../../data/store.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import recorded from "../files/recorded-feed.fixture.json";
import { AgentPanel } from "../shell/AgentPanel.tsx";

// No future LiveTab import or renderTab injection in card cases. This is the real default slot.
// Immutable S-2 wire fixture provenance: test/overlays/agent-panel/files/recorded-feed.test.ts.
// New variants below are explicitly synthetic, using the existing ToolCallFrame/EvidenceResponse.
const A = "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5:afdf84bea07a9064c";
const B = "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5:a0b4668e13e056653";
const LEAD = "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const NOTES = "/tmp/spike-s2/proj/notes.txt";
const HELLO = "/tmp/spike-s2/proj/hello.txt";
const SECRET = "live-test-paired-session";
const SINCE = "2026-10-31T12:00:00Z";
type Frame = { id: number; data: ToolCallFrame };
const wire: { frames: Frame[]; evidence: Record<string, EvidenceResponse> } = JSON.parse(
  JSON.stringify(recorded),
);
let frames: Frame[];
let bodies: Record<string, EvidenceResponse>;
interface RequestRecord {
  url: URL;
  method: string;
  headers: Headers;
  signal: AbortSignal | null;
}
interface Feed extends RequestRecord {
  cancelled: boolean;
  send: (frame: Frame) => void;
}
let requests: RequestRecord[];
let feeds: Feed[];
let heldId: string | undefined;
let release: (() => void) | undefined;
const slot = () => page.getByTestId("agent-panel-tab-slot");
const cards = () => slot().getByRole("article");
const card = (text: string) => cards().filter({ hasText: text });
const turn = () => new Promise((resolve) => setTimeout(resolve, 50));
const evidenceRequests = () => requests.filter((r) => r.url.pathname.startsWith("/v1/evidence/"));
const feedFor = (id: string, project = "spike") =>
  feeds.find(
    (f) =>
      decodeURIComponent(f.url.pathname) === `/v1/agents/${id}/feed` &&
      f.url.searchParams.get("projectId") === project,
  );
function seed(store: DataStore, project = "spike") {
  store.getState().reset(project);
  store.getState().applySnapshotState({
    ...initialState(project),
    agents: Object.fromEntries(
      [LEAD, A, B].map((id) => [
        id,
        {
          id,
          sourceId: "claude-code",
          kind: id === LEAD ? ("session" as const) : ("subagent" as const),
          ...(id === LEAD ? {} : { parentAgentId: LEAD }),
          displayName: id === B ? "Pip" : id === A ? "Editor" : "Lead",
          registered: true,
          connection: "connected" as const,
          toolCallCount: 0,
          consecutiveToolFailures: 0,
          firstSeenAt: SINCE,
          lastSeenAt: SINCE,
        },
      ]),
    ),
  });
}
function props(id = A, mode: OverlayProps["mode"] = "live", select = vi.fn()): OverlayProps {
  return {
    mode,
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId: id, select },
    anchors: createAnchorSource(),
    intents: { available: mode === "live", run: () => {} },
    settings: { get: (_key, fallback) => fallback, set: () => {} },
  };
}
function panel(store: DataStore, id = A, select = vi.fn()) {
  return (
    <SessionProvider value={SECRET}>
      <AgentPanel {...props(id, "live", select)} store={store} />
    </SessionProvider>
  );
}
async function mount(id = A, select = vi.fn()) {
  const store = createDataStore({ now: () => Date.parse(SINCE) });
  seed(store);
  const view = await render(panel(store, id, select));
  await expect.element(slot()).toHaveAttribute("data-tab", "live");
  return { store, view };
}
function recordedTool(tool: string, agent: string) {
  frames = wire.frames.filter((f) => f.data.agentId === agent && f.data.toolName === tool);
}
// Browser equivalent of the real evidenceId encoding: opaque base64url JSON tuple, no invented route.
function bodyId(call: string, part: "input" | "output") {
  return btoa(JSON.stringify(["spike", call, part]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function synthetic(
  toolName: string,
  call: string,
  input?: unknown,
  output?: unknown,
  filePaths: string[] = [],
) {
  const data: ToolCallFrame = {
    toolCallId: call,
    agentId: A,
    toolName,
    phase: "succeeded",
    filePaths,
    evidence: { input: null, output: null },
  };
  for (const part of ["input", "output"] as const) {
    const value = part === "input" ? input : output;
    if (value === undefined) continue;
    const id = bodyId(call, part);
    const text = JSON.stringify(value);
    bodies[id] = {
      id,
      projectId: "spike",
      toolCallId: call,
      part,
      text,
      bytes: new TextEncoder().encode(text).length,
      masks: [],
      truncated: false,
    };
    data.evidence[part] = { id, status: "stored" };
  }
  const frame = { id: 100 + frames.length, data };
  frames.push(frame);
  return frame;
}
beforeEach(() => {
  frames = [];
  bodies = { ...wire.evidence };
  requests = [];
  feeds = [];
  heldId = undefined;
  release = undefined;
  selectProject("spike");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), location.origin), init);
    const entry = {
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      signal: init?.signal ?? null,
    };
    requests.push(entry);
    if (/^\/v1\/agents\/[^/]+\/feed$/.test(entry.url.pathname)) {
      const feed: Feed = { ...entry, cancelled: false, send: () => {} };
      feeds.push(feed);
      const agent = decodeURIComponent(entry.url.pathname.split("/")[3]);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            feed.send = (frame) =>
              controller.enqueue(
                new TextEncoder().encode(
                  `id: ${frame.id}\nevent: toolcall\ndata: ${JSON.stringify(frame.data)}\n\n`,
                ),
              );
            if (entry.url.searchParams.get("projectId") === "spike")
              for (const frame of frames.filter((f) => f.data.agentId === agent)) feed.send(frame);
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
      const body = bodies[id];
      if (id === heldId)
        return new Promise<Response>((resolve) => {
          release = () => resolve(Response.json(body));
        });
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected Live route: ${entry.url.pathname}`);
  });
});
afterEach(() => {
  release?.();
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
});

describe("M5.06 default Live card contracts (intentional red)", () => {
  it("shows only the exact recorded Edit fragment and a safe editor link", async () => {
    recordedTool("Edit", A);
    await mount();
    await expect.element(slot().getByText("beta", { exact: true }), { timeout: 800 }).toBeVisible();
    await expect.element(slot().getByText("BETA", { exact: true })).toBeVisible();
    expect(cards().elements()).toHaveLength(1);
    const edit = cards().element();
    expect(edit.textContent).not.toMatch(/alpha|gamma|@@|line 1/i);
    const link = edit.querySelector<HTMLAnchorElement>("a[href]");
    expect(link).not.toBeNull();
    expect(new URL(link?.href ?? "").protocol).toBe("vscode:");
    expect(decodeURIComponent(link?.href ?? "")).toContain(NOTES);
    // Never click an external editor link.
  });

  it("shows recorded Write content without manufacturing an old-file diff", async () => {
    recordedTool("Write", B);
    await mount(B);
    await expect.element(card(HELLO), { timeout: 800 }).toBeVisible();
    await expect.element(card(HELLO)).toMatchTextContent("hello from B");
    expect(card(HELLO).element().querySelectorAll("del, ins")).toHaveLength(0);
    expect(card(HELLO).element().textContent).not.toMatch(/@@|old file|120 lines/i);
  });

  it("shows the exact recorded Bash command and captured stdout, expandable to full output", async () => {
    recordedTool("Bash", B);
    await mount(B);
    await expect.element(card("cat /tmp/spike-s2/proj/hello.txt"), { timeout: 800 }).toBeVisible();
    const bash = card("cat /tmp/spike-s2/proj/hello.txt");
    await expect.element(bash).toMatchTextContent("hello from B");
    await bash.getByRole("button", { name: /expand|output|details/i }).click();
    expect(bash.element().querySelector("pre")?.textContent).toContain("hello from B");
  });

  it("expands a synthetic Bash tail to exactly the full captured output", async () => {
    const stdout = Array.from({ length: 40 }, (_, i) => `captured-line-${i + 1}`).join("\n");
    synthetic(
      "Bash",
      "synthetic-output",
      { command: "printf captured-output" },
      { stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
    );
    await mount();
    await expect.element(card("printf captured-output"), { timeout: 800 }).toBeVisible();
    const bash = card("printf captured-output");
    await expect.element(bash).toMatchTextContent("captured-line-40");
    await bash.getByRole("button", { name: /expand|output|details/i }).click();
    expect(Array.from(bash.element().querySelectorAll("pre"), (pre) => pre.textContent)).toContain(
      stdout,
    );
  });

  it("groups recorded Read file facts without inventing additional files", async () => {
    recordedTool("Read", A);
    await mount();
    await expect.element(card(NOTES), { timeout: 800 }).toBeVisible();
    await expect.element(card(NOTES)).toMatchTextContent(/read/i);
    expect(cards().elements()).toHaveLength(1);
    expect(slot().element().textContent).not.toContain(HELLO);
  });

  it("groups synthetic Search calls using the supplied query and file facts", async () => {
    synthetic(
      "Grep",
      "synthetic-search",
      { pattern: "attention", path: "/tmp/spike-s2/proj" },
      { filenames: [NOTES, HELLO], numFiles: 2 },
      [NOTES, HELLO],
    );
    await mount();
    await expect.element(card("attention"), { timeout: 800 }).toBeVisible();
    await expect.element(card("attention")).toMatchTextContent(NOTES);
    await expect.element(card("attention")).toMatchTextContent(HELLO);
    expect(cards().elements()).toHaveLength(1);
  });

  it("selects the actual child ID from the recorded spawn result", async () => {
    recordedTool("Agent", LEAD);
    // Only one call needed. Its recorded result contains the child's source ID.
    const firstId = frames[0].data.toolCallId;
    frames = frames.filter((f) => f.data.toolCallId === firstId);
    const select = vi.fn();
    await mount(LEAD, select);
    await expect.element(cards(), { timeout: 800 }).toBeVisible();
    await cards()
      .getByRole("button", { name: /Editor|afdf84bea07a9064c/i })
      .click();
    expect(select).toHaveBeenCalledWith(A);
  });

  it("selects the actual recipient ID from a synthetic message chip", async () => {
    // Real SendMessage uses `to` and nested message; recipient_kind records ID vs name.
    synthetic(
      "SendMessage",
      "synthetic-message",
      {
        to: B,
        recipient: B,
        recipient_kind: "agent_id",
        message: { type: "message", content: "ready" },
      },
      { success: true, target: B },
    );
    const select = vi.fn();
    await mount(A, select);
    await expect.element(cards(), { timeout: 800 }).toBeVisible();
    await cards()
      .getByRole("button", { name: /Pip|a0b4668e13e056653/i })
      .click();
    expect(select).toHaveBeenCalledWith(B);
  });

  it("updates a running recorded call in place and ignores redelivered completions", async () => {
    recordedTool("Edit", A);
    const completed = frames.find((f) => f.data.phase === "succeeded");
    if (!completed) throw new Error("recorded completed Edit absent");
    frames = frames.filter((f) => f.data.phase === "running");
    // Another independent running call makes ordering observable, without a large DOM requirement.
    const other = wire.frames.find(
      (f) => f.data.agentId === A && f.data.toolName === "Bash" && f.data.phase === "running",
    );
    if (!other) throw new Error("recorded running Bash absent");
    frames.push(other);
    await mount();
    await expect.element(cards().nth(0), { timeout: 800 }).toMatchTextContent(/running/i);
    const original = cards().elements()[0];
    feedFor(A)?.send({ ...completed, id: 50 });
    feedFor(A)?.send({ ...completed, id: 51 });
    await expect.element(cards().nth(0)).not.toMatchTextContent(/running/i);
    expect(cards().elements()).toHaveLength(2);
    expect(cards().elements()[0]).toBe(original);
  });

  it("keeps a missing PostToolUse running and marks absent output and timing honestly", async () => {
    frames = wire.frames.filter(
      (f) => f.data.agentId === A && f.data.toolName === "Bash" && f.data.phase === "running",
    );
    await mount();
    await expect.element(cards(), { timeout: 800 }).toMatchTextContent(/running/i);
    await expect.element(cards()).toMatchTextContent("not reported");
    expect(cards().element().textContent).not.toMatch(/succeeded|failed|0 ms|exit 0/i);
  });

  it("marks synthetic absent input, output, path and timing as not reported", async () => {
    synthetic("Write", "synthetic-missing");
    await mount();
    await expect.element(cards(), { timeout: 800 }).toBeVisible();
    expect(
      cards()
        .element()
        .textContent?.match(/not reported/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(cards().element().textContent).not.toMatch(/new file|0 lines|0 ms|@@/i);
  });

  it("identifies the synthetic pending request and offers the existing request/session flow", async () => {
    const store = createDataStore({ now: () => Date.parse(SINCE) });
    seed(store);
    const state = store.getState().state;
    if (!state) throw new Error("seed state absent");
    store.getState().applySnapshotState({
      ...state,
      sessions: {
        "synthetic-session": {
          id: "synthetic-session",
          agentId: A,
          sourceId: "claude-code",
          provenance: "live",
          firstSeenAt: SINCE,
          startedAt: SINCE,
          startSeq: 1,
          workingDirectory: "/tmp/spike-s2/proj",
          activity: { activity: "unknown", heuristic: false, since: SINCE },
        },
      },
      requests: {
        "synthetic-request": {
          id: "synthetic-request",
          agentId: A,
          sessionId: "synthetic-session",
          kind: "permission",
          toolName: "Bash",
          answerable: true,
          openedAt: SINCE,
          state: "open",
          late: false,
          mergedRequestIds: [],
        },
      },
    });
    store.setState({
      attention: [
        {
          agentId: A,
          level: "needs_you",
          kind: "permission",
          since: SINCE,
          requestId: "synthetic-request",
          heuristic: false,
        },
      ],
    });
    await render(panel(store));
    await expect.element(card("synthetic-request"), { timeout: 800 }).toBeVisible();
    await expect.element(card("synthetic-request")).toMatchTextContent("Bash");
    await expect
      .element(
        card("synthetic-request").getByRole("button", { name: /request|action card|session/i }),
      )
      .toBeVisible();
    // This phase pins the entry point only. The existing ActionCard owns decisions/session.open;
    // no Allow/Deny command implementation or full OverlayRoot arbitration is accepted here.
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("masks a known synthetic secret-looking body and renders literal HTML as text", async () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
    const html = '<img src="x" onerror="throw 1">';
    synthetic(
      "Write",
      "synthetic-mask-html",
      { file_path: NOTES, content: `${html}\nGH=${token}` },
      undefined,
      [NOTES],
    );
    await mount();
    await expect.element(card(NOTES), { timeout: 800 }).toBeVisible();
    await expect.element(card(NOTES)).toMatchTextContent(html);
    expect(card(NOTES).element().textContent).not.toContain(token);
    expect(card(NOTES).element().querySelectorAll("img, script")).toHaveLength(0);
  });

  it("connects the paired selected-project feed and identity-correlated evidence", async () => {
    recordedTool("Edit", A);
    const { view } = await mount();
    await expect.poll(() => feedFor(A), { timeout: 800 }).toBeDefined();
    await expect.element(card(NOTES)).toMatchTextContent("BETA");
    expect(evidenceRequests().length).toBeGreaterThan(0);
    const allowed = new Set(
      frames.flatMap((f) => [f.data.evidence.input?.id, f.data.evidence.output?.id]),
    );
    for (const request of requests) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("X-Taskville-Session")).toBe(SECRET);
    }
    for (const request of evidenceRequests())
      expect(allowed.has(decodeURIComponent(request.url.pathname.split("/").at(-1) ?? ""))).toBe(
        true,
      );
    await view.unmount();
    await expect.poll(() => feeds.every((f) => f.signal?.aborted && f.cancelled)).toBe(true);
  });

  it.each(["id", "projectId", "toolCallId"] as const)(
    "does not display evidence with mismatched %s",
    async (field) => {
      const frame = synthetic(
        "Write",
        "synthetic-identity",
        { file_path: NOTES, content: "WRONG BODY" },
        undefined,
        [NOTES],
      );
      const input = frame.data.evidence.input;
      if (!input) throw new Error("synthetic input absent");
      bodies[input.id] = { ...bodies[input.id], [field]: "different-identity" };
      await mount();
      await expect.element(card(NOTES), { timeout: 800 }).toBeVisible();
      await expect.poll(() => evidenceRequests().length).toBeGreaterThan(0);
      await turn();
      expect(card(NOTES).element().textContent).not.toContain("WRONG BODY");
      await expect.element(card(NOTES)).toMatchTextContent("not reported");
    },
  );

  it.each(["selection", "project", "unmount"] as const)(
    "cancels old work on %s and rejects late evidence",
    async (change) => {
      recordedTool("Edit", A);
      const input = frames[0].data.evidence.input;
      if (!input) throw new Error("recorded Edit input absent");
      heldId = input.id;
      const { store, view } = await mount();
      await expect.poll(() => release, { timeout: 800 }).toBeDefined();
      const old = evidenceRequests().find((r) => r.url.pathname.endsWith(input.id));
      if (change === "selection") await view.rerender(panel(store, B));
      else if (change === "project") {
        selectProject("beta");
        seed(store, "beta");
      } else await view.unmount();
      await expect.poll(() => old?.signal?.aborted).toBe(true);
      await expect.poll(() => feedFor(A)?.signal?.aborted && feedFor(A)?.cancelled).toBe(true);
      release?.(); // Transport intentionally ignores abort, to exercise stale-response protection.
      await turn();
      expect(page.getByText("BETA", { exact: true }).elements()).toHaveLength(0);
      if (change !== "unmount")
        await expect
          .poll(() =>
            feedFor(change === "selection" ? B : A, change === "project" ? "beta" : "spike"),
          )
          .toBeDefined();
    },
  );
});

describe("M5.06 history and controlled-slot isolation controls", () => {
  it("renders the historical shell without SessionProvider or live reads", async () => {
    const store = createDataStore();
    seed(store);
    await render(<AgentPanel {...props(A, "history")} store={store} />);
    await expect.element(slot()).toHaveAttribute("data-tab", "live");
    await turn();
    expect(requests).toHaveLength(0);
  });
  it.each(["live", "history"] as const)(
    "keeps an explicit %s renderTab override independent of pairing",
    async (mode) => {
      const store = createDataStore();
      seed(store);
      await render(
        <AgentPanel
          {...props(A, mode)}
          store={store}
          renderTab={(tab, id) => <p>{`injected ${tab} ${id}`}</p>}
        />,
      );
      await expect.element(slot()).toMatchTextContent(`injected live ${A}`);
      await turn();
      expect(requests).toHaveLength(0);
    },
  );
});
