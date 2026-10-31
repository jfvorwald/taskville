import { afterEach, describe, expect, it } from "vitest";
import { bearer, CLI_TOKEN, HOST, ORIGIN, sessionHeaders } from "../http/helpers.ts";
import {
  addProject,
  BASE,
  bootInProcess,
  type Engine,
  ingest,
  input,
  SseReader,
  streamRequest,
  useDbPath,
} from "./helpers.ts";

// Security review #17: F1 (revoked session keeps its stream) and F5 (no stream
// cap, unbounded wait after a slow-consumer cut-off).

const dbPath = useDbPath();
let engine: Engine | undefined;
afterEach(() => {
  engine?.close();
  engine = undefined;
});

async function waitFor(check: () => boolean, ms = 1000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("F1: revoking pairings ends browser-session streams", () => {
  it("stops delivering to a session stream after POST /v1/pairing/revoke, but not to a CLI stream", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    addProject(engine.storage, "demo");
    const session = booted.pairing.exchange(booted.pairing.issueCode()) ?? "";

    const browser = new SseReader(
      await streamRequest(
        booted.app,
        "unsorted",
        { ...sessionHeaders(session), Origin: ORIGIN },
        "?after=1",
      ),
    );
    const cli = new SseReader(
      await streamRequest(booted.app, "unsorted", bearer(CLI_TOKEN), "?after=1"),
    );

    const revoke = await booted.app.request(`${BASE}/v1/pairing/revoke`, {
      method: "POST",
      headers: bearer(CLI_TOKEN),
    });
    expect(await revoke.json()).toEqual({ revoked: 1 });

    await ingest(booted.app, [input("e1", { projectId: "unsorted" })]);
    expect(await browser.next()).toBeNull();
    expect((await cli.events(1)).map((f) => f.id)).toEqual([2]);
    await cli.cancel();

    const reconnect = await streamRequest(booted.app, "unsorted", {
      ...sessionHeaders(session),
      Origin: ORIGIN,
    });
    expect(reconnect.status).toBe(401);
    await waitFor(() => engine?.hub.openStreams() === 0);
    expect(engine?.hub.openStreams()).toBe(0);
  });
});

describe("F5: stream limits", () => {
  it("answers 503 too_many_streams above the stream cap, and admits again once one closes", async () => {
    const booted = bootInProcess(dbPath(), { maxStreams: 2 });
    engine = booted.engine;
    const first = new SseReader(
      await streamRequest(booted.app, "unsorted", bearer(CLI_TOKEN), "?after=1"),
    );
    const second = await streamRequest(booted.app, "unsorted", bearer(CLI_TOKEN), "?after=1");
    const third = await streamRequest(booted.app, "unsorted", bearer(CLI_TOKEN), "?after=1");
    expect(second.status).toBe(200);
    expect(third.status).toBe(503);
    expect(await third.json()).toEqual({
      error: expect.objectContaining({ code: "too_many_streams" }),
    });

    await first.cancel();
    await waitFor(() => engine?.hub.openStreams() === 1);
    const fourth = await streamRequest(booted.app, "unsorted", bearer(CLI_TOKEN), "?after=1");
    expect(fourth.status).toBe(200);
    await second.body?.cancel();
    await fourth.body?.cancel();
  });

  it("caps streams at 64 by default", () => {
    engine = bootInProcess(dbPath()).engine;
    expect(engine.maxStreams).toBe(64);
  });

  it("aborts a cut-off stream whose client never takes the resnapshot, after a bounded wait", async () => {
    const booted = bootInProcess(dbPath(), { queueLimit: 5, drainTimeoutMs: 50 });
    engine = booted.engine;
    addProject(engine.storage, "demo");
    await streamRequest(booted.app, "demo", bearer(CLI_TOKEN), "?after=1"); // never read
    for (let i = 0; i < 20; i++) await ingest(booted.app, [input(`e${i}`)]);
    expect(engine.hub.subscriberCount()).toBe(0);
    await waitFor(() => engine?.hub.openStreams() === 0, 2000);
    expect(engine.hub.openStreams()).toBe(0);
  });

  it("waits about 5 seconds by default before aborting a cut-off stream", () => {
    engine = bootInProcess(dbPath()).engine;
    expect(engine.drainTimeoutMs).toBe(5000);
  });
});

export { HOST };
