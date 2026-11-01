import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataStore } from "../../src/data/store.ts";
import { startSync } from "../../src/data/sync.ts";
import { eventBuilder, FakeEngine, PROJECT, registered, SECRET, tick } from "./fake-engine.ts";

// A failure while reading the snapshot body is a transport failure (the connection broke), not
// a bad response: it must go to the retry loop. Only content that is not valid JSON, or is valid
// JSON the schema rejects, is `bad_response`.

type Failure = () => Response;

/** Wraps the engine's fetch so the first snapshot request is answered by `first`. */
function withFirstSnapshot(engine: FakeEngine, first: Failure) {
  let served = 0;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(input).includes("/snapshot") && served === 0) {
      served += 1;
      engine.requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return first();
    }
    return engine.fetch(input, init);
  };
}

function setup(fetch: typeof globalThis.fetch) {
  const store = createDataStore({ now: () => Date.parse("2026-10-30T10:30:00Z") });
  const delays: number[] = [];
  const sync = startSync({
    store,
    projectId: PROJECT,
    secret: SECRET,
    fetch,
    sleep: async (ms) => {
      delays.push(ms);
      await tick();
    },
  });
  return { store, sync, delays };
}

/** A 200 whose body stream errors on first read, as a connection reset mid-body does. */
const bodyErrors =
  (error: unknown): Failure =>
  () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(error);
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

/** A 200 whose `json()` itself rejects with `error`, without going through the body stream. */
const jsonRejects =
  (error: unknown): Failure =>
  () => {
    const response = new Response("{}", { status: 200 });
    response.json = () => Promise.reject(error);
    return response;
  };

const bodyOf =
  (text: string): Failure =>
  () =>
    new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });

let running: { stop(): Promise<void> } | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe("snapshot body transport failures", () => {
  it.each([
    ["the body stream errors with a TypeError", bodyErrors(new TypeError("network error"))],
    [
      "the body stream errors with an AbortError-like error",
      bodyErrors(new DOMException("The operation was aborted", "AbortError")),
    ],
    ["json() rejects with a TypeError", jsonRejects(new TypeError("terminated"))],
    [
      "json() rejects with an AbortError-like error",
      jsonRejects(new DOMException("The operation was aborted", "AbortError")),
    ],
  ])("retries and reaches live when %s once", async (_name, failure) => {
    const emit = eventBuilder();
    const engine = new FakeEngine(registered(emit, "a1", "a2"));
    const { store, sync } = setup(withFirstSnapshot(engine, failure));
    running = sync;

    await vi.waitFor(() => {
      expect(store.getState().connection).toBe("live");
      expect(store.getState().cursor).toBe(2);
    });
    expect(store.getState().error).toBeNull();
    expect(store.getState().agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(engine.snapshotRequests).toHaveLength(2);
  });

  it("never marks the store failed while the body read is failing", async () => {
    const engine = new FakeEngine([]);
    const { store, sync } = setup(
      withFirstSnapshot(engine, bodyErrors(new TypeError("network error"))),
    );
    running = sync;
    const seen: string[] = [];
    store.subscribe((s, prev) => {
      if (s.connection !== prev.connection) seen.push(s.connection);
    });
    await vi.waitFor(() => expect(store.getState().connection).toBe("live"));
    expect(seen).not.toContain("failed");
  });
});

describe("snapshot content that is not a snapshot", () => {
  it.each([
    ["malformed JSON", bodyOf("{not json")],
    ["a truncated JSON document", bodyOf('{"projectId":"p1","cursor":')],
    ["valid JSON that fails the schema", bodyOf('{"projectId":"p1"}')],
  ])("fails with bad_response and stops retrying on %s", async (_name, failure) => {
    const engine = new FakeEngine([]);
    const { store, sync } = setup(withFirstSnapshot(engine, failure));
    running = sync;

    await vi.waitFor(() => expect(store.getState().connection).toBe("failed"));
    expect(store.getState().error).toBe("bad_response");
    expect(store.getState().state).toBeNull();
    const seen = engine.requests.length;
    await tick();
    await tick();
    expect(engine.requests).toHaveLength(seen);
    expect(engine.snapshotRequests).toHaveLength(1);
  });
});
