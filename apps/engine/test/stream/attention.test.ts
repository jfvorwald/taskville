import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_TOKEN, bearer, CLI_TOKEN, HOST, ORIGIN, sessionHeaders } from "../http/helpers.ts";
import {
  addProject,
  BASE,
  bootInProcess,
  type Engine,
  type Frame,
  ingest,
  input,
  SseReader,
  streamRequest,
  useDbPath,
} from "./helpers.ts";

// M4.01: GET /v1/attention/events, the global attention feed across all projects
// (ARCHITECTURE.md 2.8 and 10). Pinned shapes, to be written into http-api.md:
//
//   event: snapshot   (first frame, no id)
//   data: { "projects": [{ "projectId", "name", "attention": Attention[] }], "computedAt" }
//
//   event: attention  (whenever one project's needs_you or trouble set changes)
//   data: { "projectId", "name", "attention": Attention[], "computedAt" }
//
//   event: heartbeat  (every heartbeatMs, no id)  data: {}
//
// `attention` holds only the `needs_you` and `trouble` records of the domain
// `attention(state, now)` selector at `computedAt` (engine clock), never `waiting`.
// A snapshot lists only projects that have at least one such record; an `attention`
// frame with an empty array means the project cleared. Frames carry no `id`: the feed
// is not resumable, a reconnect starts with a fresh snapshot.

const dbPath = useDbPath();
let engine: Engine | undefined;
afterEach(() => {
  engine?.close();
  engine = undefined;
});

const T_EVENT = "2026-10-30T11:00:00Z";
let clock = Date.parse("2026-10-30T11:01:00Z");
const now = () => new Date(clock);

function setup(options: Parameters<typeof bootInProcess>[1] = {}) {
  clock = Date.parse("2026-10-30T11:01:00Z");
  const booted = bootInProcess(dbPath(), { now, ...options });
  engine = booted.engine;
  addProject(engine.storage, "alpha");
  addProject(engine.storage, "beta");
  addProject(engine.storage, "gamma");
  return booted;
}

type App = ReturnType<typeof bootInProcess>["app"];

const feedRequest = (app: App, headers: Record<string, string>) =>
  Promise.resolve(app.request(`${BASE}/v1/attention/events`, { headers }));

async function openFeed(app: App): Promise<SseReader> {
  const res = await feedRequest(app, bearer(CLI_TOKEN));
  expect(res.status).toBe(200);
  return new SseReader(res);
}

const needsYou = (projectId: string, key: string, agentId = "agent-1") =>
  input(`open-${key}`, {
    projectId,
    agentId,
    type: "request.opened",
    sessionId: `sess-${key}`,
    payload: { requestId: `req-${key}`, kind: "permission", toolName: "Bash" },
  });

/**
 * Closes the open telemetry request of `needsYou(projectId, key)`: the session's turn ended. (A
 * `request.resolved` event only counts from the engine source, so adapters cannot send one.) The
 * agent is then `waiting`, which the feed does not carry.
 */
const closeRequest = (projectId: string, key: string) =>
  input(`done-${key}`, { projectId, type: "session.turn_ended", sessionId: `sess-${key}` });

const waitFor = async (check: () => boolean, ms = 1000) => {
  for (let waited = 0; waited < ms && !check(); waited += 10) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** The next feed frame, which must not be a heartbeat. */
async function frame(reader: SseReader): Promise<Frame> {
  const next = await reader.next();
  if (next === null) throw new Error("feed ended");
  return next;
}

describe("GET /v1/attention/events credentials", () => {
  it("opens as an SSE stream for the CLI token and for a paired browser session", async () => {
    const { app, pairing } = setup();
    const cli = await feedRequest(app, bearer(CLI_TOKEN));
    expect(cli.status).toBe(200);
    expect(cli.headers.get("content-type")).toContain("text/event-stream");
    expect(cli.headers.get("access-control-allow-origin")).toBeNull();
    await cli.body?.cancel();

    const session = pairing.exchange(pairing.issueCode()) ?? "";
    const browser = await feedRequest(app, { ...sessionHeaders(session), Origin: ORIGIN });
    expect(browser.status).toBe(200);
    await browser.body?.cancel();
  });

  it("refuses the bridge token, a missing credential, a foreign Host, and a foreign Origin", async () => {
    const { app } = setup();
    const bridge = await feedRequest(app, bearer(BRIDGE_TOKEN));
    expect(bridge.status).toBe(403);
    expect(await bridge.json()).toEqual({
      error: expect.objectContaining({ code: "credential_not_allowed" }),
    });
    expect((await feedRequest(app, { Host: HOST })).status).toBe(401);
    expect(
      (await feedRequest(app, { ...bearer(CLI_TOKEN), Host: "evil.example:4807" })).status,
    ).toBe(403);
    const origin = await feedRequest(app, { ...bearer(CLI_TOKEN), Origin: "http://evil.example" });
    expect(origin.status).toBe(403);
    expect(await origin.json()).toEqual({
      error: expect.objectContaining({ code: "forbidden_origin" }),
    });
  });
});

describe("snapshot frame", () => {
  it("is sent first and is empty when no project needs attention", async () => {
    const { app } = setup();
    const reader = await openFeed(app);
    expect(await frame(reader)).toEqual({
      event: "snapshot",
      data: { projects: [], computedAt: "2026-10-30T11:01:00.000Z" },
    });
    await reader.cancel();
  });

  it("lists every project with needs_you or trouble, naming each, and omits waiting-only and quiet projects", async () => {
    const { app } = setup();
    await ingest(app, [
      needsYou("beta", "b1"),
      // gamma: an agent whose turn ended is `waiting`, which the feed does not carry.
      input("g-end", { projectId: "gamma", type: "session.turn_ended", sessionId: "sess-g" }),
      // alpha: the agent is connected and quiet, so nothing yet.
      input("a-conn", { projectId: "alpha" }),
    ]);
    // Precondition from the existing snapshot route: beta really has a needs_you record.
    const betaSnap = await app.request(`${BASE}/v1/projects/beta/snapshot`, {
      headers: bearer(CLI_TOKEN),
    });
    const body = (await betaSnap.json()) as { attention: { level: string }[] };
    expect(body.attention.map((a) => a.level)).toEqual(["needs_you"]);

    const reader = await openFeed(app);
    const first = await frame(reader);
    expect(first.event).toBe("snapshot");
    expect(first.id).toBeUndefined();
    expect(first.data).toEqual({
      projects: [
        {
          projectId: "beta",
          name: "beta",
          attention: [
            expect.objectContaining({
              agentId: "agent-1",
              level: "needs_you",
              kind: "permission",
              requestId: "req-b1",
              heuristic: false,
            }),
          ],
        },
      ],
      computedAt: "2026-10-30T11:01:00.000Z",
    });
    await reader.cancel();
  });
});

describe("attention frames", () => {
  it("delivers a needs-you opened in project B to a client that is viewing project A", async () => {
    const { app } = setup();
    // The viewer of A: A's own event stream is open, and so is the global feed.
    const viewerOfAlpha = new SseReader(await streamRequest(app, "alpha", bearer(CLI_TOKEN)));
    expect((await viewerOfAlpha.events(1)).map((f) => f.id)).toEqual([1]);
    const reader = await openFeed(app);
    expect((await frame(reader)).event).toBe("snapshot");

    await ingest(app, [needsYou("beta", "b1")]);

    const next = await frame(reader);
    expect(next.event).toBe("attention");
    expect(next.id).toBeUndefined();
    expect(next.data).toEqual({
      projectId: "beta",
      name: "beta",
      attention: [
        expect.objectContaining({
          level: "needs_you",
          kind: "permission",
          requestId: "req-b1",
          agentId: "agent-1",
        }),
      ],
      computedAt: "2026-10-30T11:01:00.000Z",
    });
    await viewerOfAlpha.cancel();
    await reader.cancel();
  });

  it("sends an empty set when the needs-you is closed", async () => {
    const { app } = setup();
    await ingest(app, [needsYou("beta", "b1")]);
    const reader = await openFeed(app);
    expect((await frame(reader)).event).toBe("snapshot");

    await ingest(app, [closeRequest("beta", "b1")]);
    expect(await frame(reader)).toEqual({
      event: "attention",
      data: {
        projectId: "beta",
        name: "beta",
        attention: [],
        computedAt: "2026-10-30T11:01:00.000Z",
      },
    });
    await reader.cancel();
  });

  it("sends a frame when a project enters trouble from an event", async () => {
    const { app } = setup();
    const reader = await openFeed(app);
    await frame(reader); // snapshot
    await ingest(app, [
      input("fail", { projectId: "alpha", type: "session.turn_failed", sessionId: "sess-a" }),
    ]);
    const next = await frame(reader);
    expect(next.event).toBe("attention");
    expect(next.data).toEqual({
      projectId: "alpha",
      name: "alpha",
      attention: [
        expect.objectContaining({ level: "trouble", kind: "stop_failure", heuristic: false }),
      ],
      computedAt: "2026-10-30T11:01:00.000Z",
    });
    await reader.cancel();
  });

  it("sends nothing for a commit that leaves a project's needs_you and trouble set unchanged", async () => {
    const { app } = setup();
    await ingest(app, [needsYou("beta", "b1")]);
    const reader = await openFeed(app);
    await frame(reader); // snapshot

    // Same set in beta (a second event that changes no record), then a real change in alpha.
    await ingest(app, [input("b-more", { projectId: "beta", agentId: "agent-2" })]);
    await ingest(app, [needsYou("alpha", "a1")]);

    const next = await frame(reader);
    expect(next.event).toBe("attention");
    expect((next.data as { projectId: string }).projectId).toBe("alpha");
    await reader.cancel();
  });

  it("sends one frame per project change, in commit order, when a batch touches two projects", async () => {
    const { app } = setup();
    const reader = await openFeed(app);
    await frame(reader); // snapshot
    await ingest(app, [needsYou("alpha", "a1"), needsYou("beta", "b1")]);
    const first = await frame(reader);
    const second = await frame(reader);
    expect([first, second].map((f) => (f.data as { projectId: string }).projectId).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    await reader.cancel();
  });
});

describe("heuristic trouble and the clock", () => {
  it("recomputes on a timer with the injected clock and labels silent trouble heuristic", async () => {
    const { app } = setup({ attentionTickMs: 20 });
    await ingest(app, [input("conn", { projectId: "alpha", occurredAt: T_EVENT })]);
    const reader = await openFeed(app);
    const snap = await frame(reader);
    expect(snap.data).toEqual({ projects: [], computedAt: "2026-10-30T11:01:00.000Z" });

    // No new events: 20 minutes of engine clock pass, past the 10 minute silence threshold.
    clock = Date.parse("2026-10-30T11:20:00Z");
    const next = await frame(reader);
    expect(next.event).toBe("attention");
    expect(next.data).toEqual({
      projectId: "alpha",
      name: "alpha",
      attention: [
        expect.objectContaining({
          agentId: "agent-1",
          level: "trouble",
          kind: "silent",
          heuristic: true,
          reason: expect.objectContaining({ text: "quiet for 20 min" }),
        }),
      ],
      computedAt: "2026-10-30T11:20:00.000Z",
    });
    await reader.cancel();
  });

  it("does not resend a silent record when only its reason text changes on later ticks", async () => {
    const { app } = setup({ attentionTickMs: 20 });
    await ingest(app, [input("conn", { projectId: "alpha", occurredAt: T_EVENT })]);
    const reader = await openFeed(app);
    await frame(reader); // snapshot
    clock = Date.parse("2026-10-30T11:20:00Z");
    expect((await frame(reader)).event).toBe("attention");

    // 5 more minutes: "quiet for 25 min" is the same record, so no frame. A real change in beta is next.
    clock = Date.parse("2026-10-30T11:25:00Z");
    await new Promise((r) => setTimeout(r, 100));
    await ingest(app, [needsYou("beta", "b1")]);
    const next = await frame(reader);
    expect((next.data as { projectId: string }).projectId).toBe("beta");
    await reader.cancel();
  });

  it("ticks every 30 seconds by default", () => {
    setup();
    expect(engine?.attentionTickMs).toBe(30_000);
  });
});

describe("stream lifecycle", () => {
  it("sends heartbeats when idle", async () => {
    const { app } = setup({ heartbeatMs: 30 });
    const reader = await openFeed(app);
    await frame(reader); // snapshot
    expect(await frame(reader)).toEqual({ event: "heartbeat", data: {} });
    await reader.cancel();
  });

  it("cuts off a client that does not read, at the engine's queueLimit, so it can resnapshot", async () => {
    const { app } = setup({ queueLimit: 3 });
    const res = await feedRequest(app, bearer(CLI_TOKEN));
    expect(res.status).toBe(200);
    expect(engine?.hub.openStreams()).toBe(1);

    // The client never reads. Each commit changes the project's set, so each is one frame; far
    // more than the limit of 3 pile up, while the default limit (1000) would hold them all.
    for (let i = 0; i < 60; i++) {
      await ingest(app, [needsYou("beta", `s${i}`, `agent-${i}`)]);
    }
    await waitFor(() => engine?.hub.openStreams() === 0);
    expect(engine?.hub.openStreams()).toBe(0);
    await res.body?.cancel();
  });

  it("cuts off a client that never reads even when no attention change happens (security L1)", async () => {
    // Nothing is ingested: only the snapshot and heartbeats are written, and the client takes none
    // of them. Each write is bounded by the drain timeout, as on the project streams.
    const { app } = setup({ heartbeatMs: 10, drainTimeoutMs: 50 });
    const res = await feedRequest(app, bearer(CLI_TOKEN));
    expect(res.status).toBe(200);
    expect(engine?.hub.openStreams()).toBe(1);

    await waitFor(() => engine?.hub.openStreams() === 0, 2000);
    expect(engine?.hub.openStreams()).toBe(0);
    await res.body?.cancel();
  });

  it("cuts off a client that read the snapshot and then stopped, with only heartbeats flowing", async () => {
    const { app } = setup({ heartbeatMs: 10, drainTimeoutMs: 50 });
    const reader = await openFeed(app);
    expect((await frame(reader)).event).toBe("snapshot");
    expect(engine?.hub.openStreams()).toBe(1);

    await waitFor(() => engine?.hub.openStreams() === 0, 2000);
    expect(engine?.hub.openStreams()).toBe(0);
    await reader.cancel();
  });

  it("keeps a client that keeps reading", async () => {
    const { app } = setup({ heartbeatMs: 10, drainTimeoutMs: 200 });
    const reader = await openFeed(app);
    expect((await frame(reader)).event).toBe("snapshot");
    for (let i = 0; i < 5; i++) {
      expect((await frame(reader)).event).toBe("heartbeat");
    }
    expect(engine?.hub.openStreams()).toBe(1);
    await reader.cancel();
  });

  it("counts toward the stream cap and is released when the client disconnects", async () => {
    const { app } = setup({ maxStreams: 1 });
    const first = await openFeed(app);
    const second = await feedRequest(app, bearer(CLI_TOKEN));
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({
      error: expect.objectContaining({ code: "too_many_streams" }),
    });
    await first.cancel();
    await waitFor(() => engine?.hub.openStreams() === 0);
    expect(engine?.hub.openStreams()).toBe(0);
    const third = await feedRequest(app, bearer(CLI_TOKEN));
    expect(third.status).toBe(200);
    await third.body?.cancel();
  });

  it("ends a browser-session feed when pairings are revoked, but not a CLI feed", async () => {
    const { app, pairing } = setup();
    const session = pairing.exchange(pairing.issueCode()) ?? "";
    const browser = new SseReader(
      await feedRequest(app, { ...sessionHeaders(session), Origin: ORIGIN }),
    );
    const cli = await openFeed(app);
    await frame(browser);
    await frame(cli);

    await app.request(`${BASE}/v1/pairing/revoke`, { method: "POST", headers: bearer(CLI_TOKEN) });
    await ingest(app, [needsYou("beta", "b1")]);
    expect(await browser.next()).toBeNull();
    expect((await frame(cli)).event).toBe("attention");
    await cli.cancel();
  });

  it("ends the feed when the engine closes", async () => {
    const { app } = setup();
    const reader = await openFeed(app);
    await frame(reader);
    engine?.close();
    engine = undefined;
    expect(await reader.next()).toBeNull();
  });
});
