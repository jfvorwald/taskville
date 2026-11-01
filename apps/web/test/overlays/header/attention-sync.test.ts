import { describe, expect, it } from "vitest";
import {
  createAttentionStore,
  startAttentionSync,
} from "../../../src/overlays/header/attentionSync.ts";
import { SESSION_HEADER } from "../../../src/pairing/pair.ts";

// M4.01: the fetch loop behind the global attention feed. One stream of
// `GET /v1/attention/events` carrying the paired session's secret, every frame applied to the
// store, and a fresh snapshot on every (re)connection because the feed has no ids to resume from.

const SECRET = "s3cret";
const T = "2026-10-30T11:00:00.000Z";
const encoder = new TextEncoder();

const needsYou = (agentId: string, requestId: string) => ({
  agentId,
  level: "needs_you" as const,
  kind: "permission" as const,
  since: T,
  requestId,
  heuristic: false,
});

const sse = (event: string, data: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const snapshot = (...projects: { projectId: string; name: string; attention: unknown[] }[]) =>
  sse("snapshot", { projects, computedAt: T });

interface OpenStream {
  push(chunk: Uint8Array): void;
  end(): void;
  request: { url: string; headers: Headers; signal: AbortSignal | undefined };
}

/** A fake `fetch` whose every call opens a stream the test then feeds by hand. */
function scriptedFeed() {
  const streams: OpenStream[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    const stream: OpenStream = {
      push: (chunk) => controller.enqueue(chunk),
      end: () => controller.close(),
      request: {
        url: String(input),
        headers: new Headers(init?.headers),
        signal: init?.signal ?? undefined,
      },
    };
    streams.push(stream);
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  /** The nth opened stream, waiting for it if it is not open yet. */
  const open = async (n: number): Promise<OpenStream> => {
    for (let waited = 0; waited < 1000 && streams.length <= n; waited += 5) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const stream = streams[n];
    if (!stream) throw new Error(`stream ${n} never opened`);
    return stream;
  };
  return { fetchImpl, streams, open };
}

const until = async (check: () => boolean, ms = 1000) => {
  for (let waited = 0; waited < ms && !check(); waited += 5) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
};

const instantSleep = (delays: number[]) => async (ms: number) => {
  delays.push(ms);
};

describe("startAttentionSync", () => {
  it("opens one stream to the attention route with the session credential and applies its frames", async () => {
    const feed = scriptedFeed();
    const store = createAttentionStore();
    const sync = startAttentionSync({
      store,
      secret: SECRET,
      fetch: feed.fetchImpl,
      sleep: instantSleep([]),
    });
    const stream = await feed.open(0);
    expect(feed.streams).toHaveLength(1);
    expect(stream.request.url).toBe("/v1/attention/events");
    expect(stream.request.headers.get(SESSION_HEADER)).toBe(SECRET);
    expect(stream.request.headers.get("Accept")).toBe("text/event-stream");
    expect(store.getState().ready).toBe(false);

    stream.push(snapshot({ projectId: "beta", name: "Beta", attention: [needsYou("a", "r1")] }));
    await until(() => store.getState().ready);
    expect(Object.keys(store.getState().feed)).toEqual(["beta"]);

    stream.push(
      sse("attention", {
        projectId: "gamma",
        name: "Gamma",
        attention: [needsYou("b", "r2")],
        computedAt: T,
      }),
    );
    await until(() => "gamma" in store.getState().feed);
    expect(Object.keys(store.getState().feed).sort()).toEqual(["beta", "gamma"]);

    // A heartbeat changes nothing, not even the identity of the feed object.
    const before = store.getState().feed;
    stream.push(sse("heartbeat", {}));
    stream.push(
      sse("attention", { projectId: "beta", name: "Beta", attention: [], computedAt: T }),
    );
    await until(() => !("beta" in store.getState().feed));
    expect(before).not.toBe(store.getState().feed);
    expect(feed.streams).toHaveLength(1);

    await sync.stop();
  });

  it("reconnects after the stream ends and replaces what it held with the fresh snapshot", async () => {
    const feed = scriptedFeed();
    const store = createAttentionStore();
    const delays: number[] = [];
    const sync = startAttentionSync({
      store,
      secret: SECRET,
      fetch: feed.fetchImpl,
      sleep: instantSleep(delays),
    });
    const first = await feed.open(0);
    first.push(snapshot({ projectId: "beta", name: "Beta", attention: [needsYou("a", "r1")] }));
    await until(() => "beta" in store.getState().feed);

    // The connection drops; the cleared need was missed while away.
    first.end();
    const second = await feed.open(1);
    expect(feed.streams).toHaveLength(2);
    expect(second.request.url).toBe("/v1/attention/events");
    expect(second.request.headers.get(SESSION_HEADER)).toBe(SECRET);
    // Still holding the stale feed until the new snapshot says otherwise.
    second.push(snapshot({ projectId: "gamma", name: "Gamma", attention: [needsYou("c", "r3")] }));
    await until(() => "gamma" in store.getState().feed);
    expect(Object.keys(store.getState().feed)).toEqual(["gamma"]);
    expect(store.getState().ready).toBe(true);

    await sync.stop();
  });

  it("reconnects after a failed request, backing off between attempts", async () => {
    const delays: number[] = [];
    let calls = 0;
    const feed = scriptedFeed();
    const fetchImpl: typeof fetch = (input, init) => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new TypeError("connection refused"));
      return feed.fetchImpl(input, init);
    };
    const store = createAttentionStore();
    const sync = startAttentionSync({
      store,
      secret: SECRET,
      fetch: fetchImpl,
      sleep: instantSleep(delays),
    });
    const stream = await feed.open(0);
    stream.push(snapshot({ projectId: "beta", name: "Beta", attention: [needsYou("a", "r1")] }));
    await until(() => store.getState().ready);
    expect(calls).toBe(3);
    // Each failed attempt waits longer than the one before; the first retry is immediate.
    expect(delays).toEqual([0, 500]);

    await sync.stop();
  });

  it("closes the request on stop and does not reconnect", async () => {
    const feed = scriptedFeed();
    const store = createAttentionStore();
    const sync = startAttentionSync({
      store,
      secret: SECRET,
      fetch: feed.fetchImpl,
      sleep: instantSleep([]),
    });
    const stream = await feed.open(0);
    stream.push(snapshot({ projectId: "beta", name: "Beta", attention: [needsYou("a", "r1")] }));
    await until(() => store.getState().ready);
    expect(stream.request.signal?.aborted).toBe(false);

    await sync.stop();
    expect(stream.request.signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(feed.streams).toHaveLength(1);
  });

  it("does not retry an unpaired session", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 401 });
    };
    const sync = startAttentionSync({
      store: createAttentionStore(),
      secret: SECRET,
      fetch: fetchImpl,
      sleep: instantSleep([]),
    });
    await until(() => calls >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    await sync.stop();
  });
});
