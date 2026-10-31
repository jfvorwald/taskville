import { createServer } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { PairingStore } from "../../src/auth/pairing.ts";
import { createApp } from "../../src/http/app.ts";
import { type RunningServer, startServer } from "../../src/http/server.ts";
import { bootEngine, type Engine } from "../../src/stream/index.ts";
import { BRIDGE_TOKEN, CLI_TOKEN } from "../http/helpers.ts";
import { addProject, type Frame, input, SseReader, useDbPath } from "./helpers.ts";

const dbPath = useDbPath();
let engine: Engine | undefined;
let server: RunningServer | undefined;

afterEach(async () => {
  engine?.close();
  await server?.close();
  engine = undefined;
  server = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

describe("SSE over a real socket", () => {
  it("streams to a fetch reader and drops the subscriber when the client aborts", async () => {
    const port = await freePort();
    const pairing = new PairingStore();
    const app = createApp({
      port,
      cliToken: CLI_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      pairing,
      logger: pino({ level: "silent" }),
    });
    engine = bootEngine({ app, dbPath: dbPath(), heartbeatMs: 60_000 });
    addProject(engine.storage, "demo");
    server = await startServer({ app, port });
    const base = `http://127.0.0.1:${port}`;
    const session = pairing.exchange(pairing.issueCode()) ?? "";

    const abort = new AbortController();
    const res = await fetch(`${base}/v1/projects/demo/events?after=1`, {
      headers: { "X-Taskville-Session": session },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    const reader = new SseReader(res);

    const post = await fetch(`${base}/v1/events/batch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CLI_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [input("e1"), input("e2")] }),
    });
    expect(post.status).toBe(200);
    const frames: Frame[] = await reader.events(2);
    expect(frames.map((f) => f.id)).toEqual([2, 3]);
    expect(engine.hub.subscriberCount()).toBe(1);

    abort.abort();
    for (let i = 0; i < 50 && engine.hub.subscriberCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(engine.hub.subscriberCount()).toBe(0);
  });
});
