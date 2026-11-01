import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { ConnectedLiveTab } from "./ConnectedLiveTab.tsx";
import { AGENT, bodyOf, PROJECT, seedStore, turn } from "./liveKit.tsx";

// M5.06 round 5 item A: the ConnectedLiveTab SSE client, against a controllable fake server.
// The fake honors `after` on every connection, can end a stream, can answer a status instead of a
// stream, and can also misbehave on purpose (redeliver old ids, send another agent's frame).
const SECRET = "synthetic-client-pairing";
interface Conn {
  url: URL;
  status: number;
  cancelled: boolean;
  send: (id: number | undefined, event: string, data: unknown) => void;
  end: () => void;
}
interface LoggedFrame {
  id: number;
  data: ToolCallFrame;
}
let conns: Conn[];
let log: LoggedFrame[];
let statuses: number[];
let evidence: Record<string, EvidenceResponse>;
let evidenceStatus: Record<string, number>;
let evidenceHits: string[];

const path = (n: number) => `/synthetic/client/call-${String(n).padStart(4, "0")}.txt`;
const frame = (n: number, extra: Partial<ToolCallFrame> = {}): ToolCallFrame => ({
  toolCallId: `client-call-${n}`,
  agentId: AGENT,
  toolName: "Write",
  phase: "succeeded",
  filePaths: [path(n)],
  evidence: { input: null, output: null },
  ...extra,
});
// A Bash call whose command lives in a stored input body, as on the wire.
const bash = (n: number, command: string, outputId?: string): ToolCallFrame => {
  const call = `client-bash-${n}`;
  const input = bodyOf(call, "input", JSON.stringify({ command }));
  evidence[input.id] = input;
  return {
    toolCallId: call,
    agentId: AGENT,
    toolName: "Bash",
    phase: "succeeded",
    filePaths: [],
    evidence: {
      input: { id: input.id, status: "stored" },
      output: outputId ? { id: outputId, status: "stored" } : null,
    },
  };
};
const slot = () => page.getByTestId("agent-panel-tab-slot");
const cards = () => slot().getByRole("article");
const card = (n: number) => cards().filter({ hasText: path(n) });
const unavailable = () => slot().getByText("Live feed unavailable.");
const after = (conn: Conn | undefined) => conn?.url.searchParams.get("after");
const LONG = { timeout: 8000 };

async function mount() {
  const store = seedStore();
  const view = await render(
    <div data-testid="agent-panel-tab-slot" style={{ height: 460, width: 400, overflowY: "auto" }}>
      <SessionProvider value={SECRET}>
        <ConnectedLiveTab agentId={AGENT} store={store} select={vi.fn()} />
      </SessionProvider>
    </div>,
  );
  await expect.poll(() => conns.length).toBeGreaterThan(0);
  return view;
}

beforeEach(() => {
  conns = [];
  log = [];
  statuses = [];
  evidence = {};
  evidenceStatus = {};
  evidenceHits = [];
  selectProject(PROJECT);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.startsWith("/v1/evidence/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
      evidenceHits.push(id);
      const status = evidenceStatus[id];
      if (status) return new Response(null, { status });
      const body = evidence[id];
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    if (!/^\/v1\/agents\/[^/]+\/feed$/.test(url.pathname))
      throw new Error(`Unexpected synthetic route ${url.pathname}`);
    const conn: Conn = {
      url,
      status: statuses.shift() ?? 200,
      cancelled: false,
      send: () => {},
      end: () => {},
    };
    conns.push(conn);
    if (conn.status !== 200) return new Response(null, { status: conn.status });
    const cursor = Number(url.searchParams.get("after") ?? 0);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          conn.send = (id, event, data) => {
            if (closed || conn.cancelled) return;
            const head = id === undefined ? "" : `id: ${id}\n`;
            controller.enqueue(
              new TextEncoder().encode(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          };
          conn.end = () => {
            if (closed || conn.cancelled) return;
            closed = true;
            controller.close();
          };
          // A well behaved server: only what is after the cursor, in id order.
          for (const entry of log.filter((f) => f.id > cursor)) {
            conn.send(entry.id, "toolcall", entry.data);
          }
        },
        cancel() {
          conn.cancelled = true;
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

describe("M5.06 ConnectedLiveTab SSE client", () => {
  it("reconnects after a clean end with ?after=<last cursor> and shows only new frames once", async () => {
    log = [
      { id: 5, data: frame(1) },
      { id: 9, data: frame(2) },
    ];
    await mount();
    await expect.element(card(2)).toBeVisible();
    expect(after(conns[0])).toBe("0");
    conns[0].end();
    await expect.poll(() => conns.length, LONG).toBe(2);
    expect(after(conns[1])).toBe("9");
    expect(conns[1].url.searchParams.get("projectId")).toBe(PROJECT);
    log.push({ id: 12, data: frame(3) });
    conns[1].send(12, "toolcall", frame(3));
    await expect.element(card(3)).toBeVisible();
    expect(cards().elements()).toHaveLength(3);
  });

  it("reconnects after a 5xx with ?after=<last cursor> and recovers", async () => {
    log = [{ id: 7, data: frame(1) }];
    await mount();
    await expect.element(card(1)).toBeVisible();
    statuses.push(503);
    conns[0].end();
    await expect.poll(() => conns.length, LONG).toBe(3);
    expect(conns[1].status).toBe(503);
    expect(after(conns[1])).toBe("7");
    expect(after(conns[2])).toBe("7");
    conns[2].send(8, "toolcall", frame(2));
    await expect.element(card(2)).toBeVisible();
    expect(cards().elements()).toHaveLength(2);
    await expect.element(unavailable()).not.toBeInTheDocument();
  });

  it("skips a redelivered frame with id <= cursor: no duplicate card and no update", async () => {
    await mount();
    const [conn] = conns;
    conn.send(5, "toolcall", frame(1, { phase: "running" }));
    await expect.element(card(1)).toBeVisible();
    // Same id again, now claiming a finish; an older id for a new call; both must be ignored.
    conn.send(5, "toolcall", frame(1, { phase: "succeeded", durationMs: 99 }));
    conn.send(3, "toolcall", frame(2));
    // The sentinel is processed after them, so everything before it has been applied.
    conn.send(6, "toolcall", frame(3));
    await expect.element(card(3)).toBeVisible();
    await turn();
    expect(card(1).elements()).toHaveLength(1);
    expect(card(2).elements()).toHaveLength(0);
    expect(slot().element().textContent).not.toContain("99 ms");
    expect(cards().elements()).toHaveLength(2);
    // A real update with a higher id still applies in place.
    conn.send(7, "toolcall", frame(1, { phase: "succeeded", durationMs: 37 }));
    await expect.element(card(1)).toMatchTextContent("37 ms");
    expect(cards().elements()).toHaveLength(2);
  });

  it("resnapshot resets the list, bodies, evicted set and cursor", async () => {
    const A = "client-bash-1:output";
    const B = "client-bash-2:output";
    evidence[A] = bodyOf("client-bash-1", "output", JSON.stringify({ stdout: "STDOUT-OF-A" }));
    evidenceStatus[B] = 410;
    log = [
      { id: 10, data: bash(1, "echo alpha", A) },
      { id: 11, data: bash(2, "echo beta", B) },
    ];
    await mount();
    const alpha = cards().filter({ hasText: "echo alpha" });
    const beta = cards().filter({ hasText: "echo beta" });
    await expect.element(alpha).toMatchTextContent("STDOUT-OF-A");
    await expect.element(beta).toMatchTextContent(/no longer stored/i);
    const hitsA = evidenceHits.filter((id) => id === A).length;
    const hitsB = evidenceHits.filter((id) => id === B).length;
    // After the reset the server starts over with lower ids; both bodies are now unavailable (404)
    // and the old evicted mark and old bodies must not leak into the new list.
    delete evidence[A];
    evidenceStatus[B] = 404;
    log = [
      { id: 1, data: bash(3, "echo gamma") },
      { id: 2, data: bash(1, "echo alpha", A) },
      { id: 3, data: bash(2, "echo beta", B) },
    ];
    conns[0].send(undefined, "resnapshot", { reason: "slow_consumer" });
    await expect.poll(() => conns.length, LONG).toBe(2);
    expect(after(conns[1])).toBe("0");
    await expect.element(cards().filter({ hasText: "echo gamma" })).toBeVisible();
    await expect.element(beta).toBeVisible();
    await turn(300);
    expect(cards().elements()).toHaveLength(3);
    expect(slot().element().textContent).not.toContain("STDOUT-OF-A");
    expect(beta.element().textContent).not.toMatch(/no longer stored/i);
    expect(evidenceHits.filter((id) => id === A).length).toBe(hitsA + 1);
    expect(evidenceHits.filter((id) => id === B).length).toBe(hitsB + 1);
  });

  it.each([400, 403, 404])(
    "a %i shows Live feed unavailable. and is not retried",
    async (status) => {
      statuses.push(status);
      await mount();
      await expect.element(unavailable()).toBeVisible();
      await turn(2500);
      expect(conns).toHaveLength(1);
      expect(evidenceHits).toHaveLength(0);
    },
    10_000,
  );

  it("drops a frame for another agent id and keeps its own", async () => {
    log = [
      { id: 1, data: frame(1, { agentId: "someone-else" }) },
      { id: 2, data: frame(2) },
    ];
    await mount();
    await expect.element(card(2)).toBeVisible();
    await turn();
    expect(card(1).elements()).toHaveLength(0);
    expect(cards().elements()).toHaveLength(1);
    conns[0].send(3, "toolcall", frame(3, { agentId: "another" }));
    conns[0].send(4, "toolcall", frame(4));
    await expect.element(card(4)).toBeVisible();
    expect(card(3).elements()).toHaveLength(0);
  });

  it("fetches the output body of a call that was unfinished and later finished with a new output ref", async () => {
    const IN = "client-bash-9:input";
    const OUT = "client-bash-9:output";
    evidence[IN] = bodyOf("client-bash-9", "input", JSON.stringify({ command: "make build" }));
    evidence[OUT] = bodyOf(
      "client-bash-9",
      "output",
      JSON.stringify({ stdout: "BUILD-OK-OUTPUT" }),
    );
    const base = {
      toolCallId: "client-bash-9",
      agentId: AGENT,
      toolName: "Bash",
      filePaths: [],
    };
    await mount();
    const [conn] = conns;
    conn.send(1, "toolcall", {
      ...base,
      phase: "running",
      evidence: { input: { id: IN, status: "stored" }, output: null },
    });
    await expect.element(cards().filter({ hasText: "make build" })).toBeVisible();
    conn.send(2, "toolcall", {
      ...base,
      phase: "unfinished",
      evidence: { input: { id: IN, status: "stored" }, output: null },
    });
    await turn();
    expect(evidenceHits).not.toContain(OUT);
    conn.send(3, "toolcall", {
      ...base,
      phase: "succeeded",
      durationMs: 12,
      evidence: {
        input: { id: IN, status: "stored" },
        output: { id: OUT, status: "stored" },
      },
    });
    await expect
      .element(cards().filter({ hasText: "make build" }))
      .toMatchTextContent("BUILD-OK-OUTPUT");
    expect(evidenceHits).toContain(OUT);
    expect(cards().elements()).toHaveLength(1);
  });
});
