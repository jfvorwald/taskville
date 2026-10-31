import { sseFrameSchema } from "@taskville/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { IngestPipeline } from "../../src/ingest/index.ts";
import { BRIDGE_TOKEN, bearer, CLI_TOKEN, ORIGIN, sessionHeaders } from "../http/helpers.ts";
import {
  addProject,
  bootInProcess,
  type Engine,
  type Frame,
  ingest,
  input,
  SseReader,
  streamRequest,
  useDbPath,
} from "./helpers.ts";

const dbPath = useDbPath();
let engine: Engine | undefined;
afterEach(() => {
  engine?.close();
  engine = undefined;
});

const events = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => input(`e${from + i}`));

const ids = (frames: Frame[]) => frames.map((f) => f.id);

function fail(): never {
  throw new Error("engine not booted");
}

function setup(options: Parameters<typeof bootInProcess>[1] = {}) {
  const booted = bootInProcess(dbPath(), options);
  engine = booted.engine;
  addProject(engine.storage, "demo");
  return booted;
}

describe("GET /v1/projects/:id/events", () => {
  it("sends the backlog after the cursor, in order, then live events", async () => {
    const { app } = setup();
    await ingest(app, events(1, 3)); // sequences 2..4
    const res = await streamRequest(app, "demo", bearer(CLI_TOKEN), "?after=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = new SseReader(res);
    const backlog = await reader.events(2);
    expect(ids(backlog)).toEqual([3, 4]);
    for (const frame of backlog) sseFrameSchema.parse(frame);

    await ingest(app, events(10, 2));
    expect(ids(await reader.events(2))).toEqual([5, 6]);
    await reader.cancel();
  });

  it("lets Last-Event-ID override ?after", async () => {
    const { app } = setup();
    await ingest(app, events(1, 3));
    const res = await streamRequest(
      app,
      "demo",
      { ...bearer(CLI_TOKEN), "Last-Event-ID": "3" },
      "?after=0",
    );
    const reader = new SseReader(res);
    expect(ids(await reader.events(1))).toEqual([4]);
    await reader.cancel();
  });

  it("starts from the beginning without a cursor", async () => {
    const { app } = setup();
    await ingest(app, events(1, 1));
    const reader = new SseReader(await streamRequest(app, "demo", bearer(CLI_TOKEN)));
    expect(ids(await reader.events(2))).toEqual([1, 2]);
    await reader.cancel();
  });

  it("sends resnapshot cursor_ahead_of_head and closes when the cursor is past the head", async () => {
    const { app } = setup();
    const reader = new SseReader(await streamRequest(app, "demo", bearer(CLI_TOKEN), "?after=9"));
    expect(await reader.next()).toEqual({
      event: "resnapshot",
      data: { reason: "cursor_ahead_of_head" },
    });
    expect(await reader.next()).toBeNull();
  });

  it("sends heartbeats with the current head when idle", async () => {
    const { app } = setup({ heartbeatMs: 30 });
    await ingest(app, events(1, 1));
    const reader = new SseReader(await streamRequest(app, "demo", bearer(CLI_TOKEN), "?after=2"));
    const frame = await reader.next();
    expect(frame).toEqual({ event: "heartbeat", data: { head: 2 } });
    sseFrameSchema.parse(frame);
    await reader.cancel();
  });

  it("answers 400 for a malformed cursor and 404 for an unknown project", async () => {
    const { app } = setup();
    for (const query of ["?after=-1", "?after=abc", "?after=1.5"]) {
      expect((await streamRequest(app, "demo", bearer(CLI_TOKEN), query)).status).toBe(400);
    }
    const bad = await streamRequest(app, "demo", { ...bearer(CLI_TOKEN), "Last-Event-ID": "x" });
    expect(bad.status).toBe(400);
    const ghost = await streamRequest(app, "ghost", bearer(CLI_TOKEN));
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toEqual({
      error: expect.objectContaining({ code: "unknown_project" }),
    });
  });

  it("accepts a browser session header and refuses the bridge token", async () => {
    const { app, pairing } = setup();
    const session = pairing.exchange(pairing.issueCode()) ?? "";
    const ok = await streamRequest(app, "demo", { ...sessionHeaders(session), Origin: ORIGIN });
    expect(ok.status).toBe(200);
    const reader = new SseReader(ok);
    expect(ids(await reader.events(1))).toEqual([1]);
    await reader.cancel();
    expect((await streamRequest(app, "demo", bearer(BRIDGE_TOKEN))).status).toBe(403);
  });

  it("removes the subscriber when the client disconnects", async () => {
    const { app } = setup();
    const reader = new SseReader(await streamRequest(app, "demo", bearer(CLI_TOKEN), "?after=1"));
    await ingest(app, events(1, 1));
    expect(ids(await reader.events(1))).toEqual([2]);
    expect(engine?.hub.subscriberCount()).toBe(1);
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(engine?.hub.subscriberCount()).toBe(0);
  });
});

describe("resume guarantees", () => {
  it("delivers events committed before a crash that skipped the broadcast, on resume", async () => {
    const first = setup();
    await ingest(first.app, events(1, 2)); // 2..3
    const reader = new SseReader(
      await streamRequest(first.app, "demo", bearer(CLI_TOKEN), "?after=1"),
    );
    const seen = ids(await reader.events(2));
    expect(seen).toEqual([2, 3]);

    // Commit without broadcasting: what a crash between COMMIT and publish leaves behind.
    new IngestPipeline({ storage: first.engine.storage }).ingest(events(20, 2)); // 4..5
    await reader.cancel();
    first.engine.close();
    engine = undefined;

    // Restart on the same database and resume from the last id the client saw.
    const second = bootInProcess(dbPath());
    engine = second.engine;
    const resumed = new SseReader(
      await streamRequest(second.app, "demo", {
        ...bearer(CLI_TOKEN),
        "Last-Event-ID": String(seen.at(-1)),
      }),
    );
    expect(ids(await resumed.events(2))).toEqual([4, 5]);
    await ingest(second.app, events(30, 1));
    expect(ids(await resumed.events(1))).toEqual([6]);
    await resumed.cancel();
  });

  it("fills a gap from storage when a live broadcast was missed, without reconnecting", async () => {
    const { app } = setup();
    const reader = new SseReader(await streamRequest(app, "demo", bearer(CLI_TOKEN), "?after=1"));
    new IngestPipeline({ storage: engine?.storage ?? fail() }).ingest(events(1, 2)); // 2..3, never broadcast
    await ingest(app, events(10, 1)); // 4, broadcast
    expect(ids(await reader.events(3))).toEqual([2, 3, 4]);
    await reader.cancel();
  });

  it("sends a backlog longer than one storage page in full without any live event", async () => {
    const { app } = setup();
    for (let i = 0; i < 6; i++) await ingest(app, events(i * 100, 100)); // 2..601
    const reader = new SseReader(await streamRequest(app, "demo", bearer(CLI_TOKEN), "?after=1"));
    const frames = await reader.events(600);
    expect(ids(frames)).toEqual(Array.from({ length: 600 }, (_, i) => i + 2));
    await reader.cancel();
  });

  it("drops a repeated or late broadcast of events the stream already sent", async () => {
    const { app } = setup();
    await ingest(app, events(1, 2)); // 2..3
    const reader = new SseReader(await streamRequest(app, "demo", bearer(CLI_TOKEN), "?after=1"));
    expect(ids(await reader.events(2))).toEqual([2, 3]);
    const old = [...(engine?.storage.events("demo", 1) ?? [])];
    engine?.hub.publish({ events: old, heads: { demo: 3 } });
    await ingest(app, events(10, 1));
    expect(ids(await reader.events(1))).toEqual([4]);
    await reader.cancel();
  });

  it("has zero gaps and zero duplicates across 100 disconnect cycles under live ingest", async () => {
    const { app } = setup();
    const received: number[] = [];
    let last = 1;
    let produced = 0;
    for (let cycle = 0; cycle < 100; cycle++) {
      // Events land before, during, and after each connection.
      await ingest(app, events(produced, 2));
      produced += 2;
      const reader = new SseReader(
        await streamRequest(app, "demo", { ...bearer(CLI_TOKEN), "Last-Event-ID": String(last) }),
      );
      const ingesting = ingest(app, events(produced, 1));
      produced += 1;
      const take = 1 + (cycle % 3);
      const frames = await reader.events(take);
      await ingesting;
      await reader.cancel();
      for (const frame of frames) received.push(frame.id ?? -1);
      last = received.at(-1) ?? last;
    }
    const reader = new SseReader(
      await streamRequest(app, "demo", { ...bearer(CLI_TOKEN), "Last-Event-ID": String(last) }),
    );
    const head = engine?.storage.head("demo") ?? 0;
    for (const frame of await reader.events(head - last)) received.push(frame.id ?? -1);
    await reader.cancel();

    expect(received).toEqual(Array.from({ length: head - 1 }, (_, i) => i + 2));
    expect(produced).toBe(300);
  }, 30_000);
});

describe("slow consumers", () => {
  it("cuts off a subscriber whose queue fills, with resnapshot slow_consumer, while others continue", async () => {
    const { app } = setup({ queueLimit: 50 });
    const slowRes = await streamRequest(app, "demo", bearer(CLI_TOKEN), "?after=1");
    const fast = new SseReader(await streamRequest(app, "demo", bearer(CLI_TOKEN), "?after=1"));
    // Let both reach the live phase before flooding.
    await ingest(app, events(0, 1));
    expect(ids(await fast.events(1))).toEqual([2]);

    for (let batch = 0; batch < 10; batch++) {
      await ingest(app, events(100 + batch * 20, 20));
      expect((await fast.events(20)).length).toBe(20);
    }
    expect(engine?.storage.head("demo")).toBe(202);

    const slow = new SseReader(slowRes);
    const frames: Frame[] = [];
    for (;;) {
      const frame = await slow.next();
      if (frame === null) break;
      frames.push(frame);
    }
    const last = frames.at(-1);
    expect(last).toEqual({ event: "resnapshot", data: { reason: "slow_consumer" } });
    const delivered = frames.filter((f) => f.event === "event").map((f) => f.id ?? 0);
    expect(delivered.length).toBeLessThan(60);
    expect(delivered).toEqual(delivered.map((_, i) => i + 2));
    expect(engine?.hub.subscriberCount()).toBe(1);

    await ingest(app, events(900, 1));
    expect(ids(await fast.events(1))).toEqual([203]);
    await fast.cancel();
  });

  it("uses a 1,000-frame queue by default", () => {
    setup();
    expect(engine?.queueLimit).toBe(1000);
  });
});
