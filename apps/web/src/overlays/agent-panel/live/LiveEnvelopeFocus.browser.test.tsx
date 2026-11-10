import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { createFeedFocus, type FeedFocus } from "../../../city/crew/envelopes/feedFocus.ts";
import { type Agent, initialState, type ProjectState } from "../../../data/domain.ts";
import { selectProject } from "../../../data/project.ts";
import { createDataStore, type DataStore } from "../../../data/store.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";
import { bodyOf, turn } from "./liveKit.tsx";

// M5.28 (decision #556, roborev 6845): a clicked envelope focuses the exact SendMessage card in
// the sender's Live feed, found by the toolCallId the team.message event carries. The request
// reaches the panel through the feed hand-off (`feedFocus.request(agentId, eventId, toolCallId)`).
// These tests go through the real AgentPanel and ConnectedLiveTab, against a fake feed server, so
// they pin behavior and not how the tab learns of the request.
//
// Red now: the Live tab never focuses a card for an envelope request.

const PROJECT = "m528";
const SECRET = "synthetic-m528-pairing";
const AT = "2026-11-03T12:00:00.000Z";
const LONG = { timeout: 8000 };

interface Conn {
  agent: string;
  send: (id: number, data: ToolCallFrame) => void;
}
let conns: Conn[];
let logs: Record<string, { id: number; data: ToolCallFrame }[]>;
let evidence: Record<string, EvidenceResponse>;

const teammate = (id: string, displayName: string): Agent =>
  ({
    id,
    sourceId: "claude-code",
    sourceAgentId: id,
    displayName,
    kind: "teammate",
    registered: true,
    connection: "connected",
    firstSeenAt: AT,
    lastSeenAt: AT,
    toolCallCount: 0,
    consecutiveToolFailures: 0,
  }) as Agent;

function seedStore(): DataStore {
  const store = createDataStore();
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState({
    ...initialState(PROJECT),
    agents: Object.fromEntries(
      [teammate("pip", "Pip"), teammate("bo", "Bo")].map((a) => [a.id, a]),
    ),
  } as unknown as ProjectState);
  return store;
}

let seq: Record<string, number>;
/** Builds frames for `agent` and registers their input bodies; ids are consecutive per agent. */
function frames(agent: string, specs: readonly (string | { call: string; to: string })[]) {
  return specs.map((spec) => {
    seq[agent] = (seq[agent] ?? 0) + 1;
    const n = seq[agent] as number;
    const startedAt = new Date(Date.parse(AT) + n * 1000).toISOString();
    if (typeof spec === "string") {
      const filler: ToolCallFrame = {
        toolCallId: spec,
        agentId: agent,
        toolName: "Write",
        phase: "succeeded",
        filePaths: [`/synthetic/m528/${spec}.txt`],
        evidence: { input: null, output: null },
        startedAt,
      };
      return { id: n, data: filler };
    }
    // Evidence ids are per agent here, so two agents reusing one call id (case c) keep their own bodies.
    const input = {
      ...bodyOf(spec.call, "input", JSON.stringify({ to: spec.to, message: "hi" }), [], PROJECT),
      id: `${agent}:${spec.call}:input`,
    };
    evidence[input.id] = input;
    const send: ToolCallFrame = {
      toolCallId: spec.call,
      agentId: agent,
      toolName: "SendMessage",
      phase: "succeeded",
      filePaths: [],
      evidence: { input: { id: input.id, status: "stored" }, output: null },
      startedAt,
    };
    return { id: n, data: send };
  });
}
const fill = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
const send = (call: string, to: string) => ({ call, to });

/** Delivers frames now: into the log for later connections, and down every open stream. */
function deliver(agent: string, list: ReturnType<typeof frames>) {
  logs[agent] = [...(logs[agent] ?? []), ...list];
  for (const conn of conns.filter((c) => c.agent === agent)) {
    for (const f of list) conn.send(f.id, f.data);
  }
}

beforeEach(() => {
  conns = [];
  logs = {};
  evidence = {};
  seq = {};
  selectProject(PROJECT);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.startsWith("/v1/evidence/")) {
      const body = evidence[decodeURIComponent(url.pathname.slice("/v1/evidence/".length))];
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    const feed = /^\/v1\/agents\/([^/]+)\/feed$/.exec(url.pathname);
    if (!feed) return new Response(null, { status: 404 });
    const agent = decodeURIComponent(feed[1] as string);
    const cursor = Number(url.searchParams.get("after") ?? 0);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (id: number, data: ToolCallFrame) =>
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${id}\nevent: toolcall\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          conns.push({ agent, send: write });
          for (const f of (logs[agent] ?? []).filter((x) => x.id > cursor)) write(f.id, f.data);
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
});
afterEach(() => vi.unstubAllGlobals());

function props(selectedId: string): OverlayProps {
  return {
    mode: "live",
    selection: { selectedId, select: vi.fn() },
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    anchors: createAnchorSource(),
    intents: { available: true, run: vi.fn() },
    settings: { get: (_key, fallback) => fallback, set: vi.fn() },
  };
}
const panel = (store: DataStore, feedFocus: FeedFocus, selectedId: string) => (
  <div style={{ height: 700, width: 420 }}>
    <SessionProvider value={SECRET}>
      <AgentPanel {...props(selectedId)} store={store} feedFocus={feedFocus} />
    </SessionProvider>
  </div>
);
async function open(selectedId: string, feedFocus: FeedFocus = createFeedFocus()) {
  const store = seedStore();
  const view = await render(panel(store, feedFocus, selectedId));
  return {
    feedFocus,
    store,
    view,
    show: (id: string) => view.rerender(panel(store, feedFocus, id)),
  };
}

/** The text of the logbook entry that holds keyboard focus, or null when none does. */
const focused = () =>
  document.activeElement?.closest('[data-testid="logbook-entry"]')?.textContent ?? null;
const sent = (to: string) => new RegExp(`Sent ${to} a message`);
const cardCount = () => document.querySelectorAll('[data-testid="logbook-entry"]').length;

describe("an envelope request focuses the exact SendMessage card", () => {
  it("focuses the requested card, not the nearer or newer SendMessage card", async () => {
    // alpha and beta are one second apart and beta is the newest SendMessage; many calls follow.
    deliver(
      "pip",
      frames("pip", [
        ...fill("early", 4),
        send("call-alpha", "alpha"),
        send("call-beta", "beta"),
        ...fill("late", 30),
      ]),
    );
    const { feedFocus } = await open("pip");
    await expect.poll(cardCount, LONG).toBeGreaterThan(0);
    feedFocus.request("pip", "event-1", "call-alpha");
    await expect.poll(focused, LONG).toMatch(sent("alpha"));
  }, 60_000);

  it("(a) still focuses the card when the panel mounts after the click", async () => {
    deliver(
      "pip",
      frames("pip", [...fill("early", 4), send("call-alpha", "alpha"), ...fill("late", 30)]),
    );
    const feedFocus = createFeedFocus();
    feedFocus.request("pip", "event-1", "call-alpha");
    await open("pip", feedFocus);
    await expect.poll(focused, LONG).toMatch(sent("alpha"));
  }, 60_000);

  it("waits for the card to reach the feed, then focuses it", async () => {
    deliver("pip", frames("pip", fill("early", 6)));
    const { feedFocus } = await open("pip");
    await expect.poll(cardCount, LONG).toBeGreaterThan(0);
    feedFocus.request("pip", "event-1", "call-alpha");
    await turn(400);
    expect(focused()).toBeNull();
    deliver("pip", frames("pip", [send("call-alpha", "alpha")]));
    // The feed itself works: the card is shown (this passes today); only the focus is missing.
    await expect.poll(() => document.body.textContent, LONG).toMatch(sent("alpha"));
    await expect.poll(focused, LONG).toMatch(sent("alpha"));
  }, 60_000);

  it("(b) a batch of SendMessage calls without the target does not use up the request", async () => {
    const { feedFocus } = await open("pip");
    feedFocus.request("pip", "event-1", "call-gamma");
    await turn(200);
    deliver(
      "pip",
      frames("pip", [send("call-alpha", "alpha"), send("call-beta", "beta"), ...fill("mid", 3)]),
    );
    await expect.poll(cardCount, LONG).toBeGreaterThan(3);
    await turn(400);
    expect(focused()).toBeNull();
    deliver("pip", frames("pip", [send("call-gamma", "gamma"), ...fill("tail", 3)]));
    await expect.poll(focused, LONG).toMatch(sent("gamma"));
  }, 60_000);

  it("(b) a batch holding several SendMessage calls focuses the requested one, not the first", async () => {
    const { feedFocus } = await open("pip");
    feedFocus.request("pip", "event-1", "call-beta");
    await turn(200);
    deliver(
      "pip",
      frames("pip", [
        send("call-alpha", "alpha"),
        send("call-beta", "beta"),
        send("call-gamma", "gamma"),
      ]),
    );
    await expect.poll(focused, LONG).toMatch(sent("beta"));
  }, 60_000);

  it("(c) does not carry the request to another agent's panel", async () => {
    deliver("pip", frames("pip", [...fill("pip-early", 3), send("call-alpha", "alpha")]));
    // The same call id in bo's feed: a leaked token would focus it.
    deliver("bo", frames("bo", [send("call-alpha", "bo-alpha"), ...fill("bo-late", 3)]));
    const { feedFocus, show } = await open("pip");
    feedFocus.request("pip", "event-1", "call-alpha");
    await expect.poll(focused, LONG).toMatch(sent("alpha"));

    await show("bo");
    await expect
      .poll(() => document.querySelector('[data-testid="logbook-entry"]')?.textContent, LONG)
      .toMatch(/bo-alpha/);
    await turn(600);
    expect(focused()).toBeNull();
  }, 60_000);

  it("(c) a request for one agent does not focus a card while another agent is shown", async () => {
    deliver("bo", frames("bo", [send("call-alpha", "bo-alpha"), ...fill("bo-late", 3)]));
    const { feedFocus } = await open("bo");
    await expect.poll(cardCount, LONG).toBeGreaterThan(0);
    feedFocus.request("pip", "event-1", "call-alpha");
    await turn(600);
    expect(focused()).toBeNull();
  }, 60_000);
});
