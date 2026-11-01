import { describe, expect, it, vi } from "vitest";
import { createDataStore } from "../../src/data/store.ts";
import { startSync } from "../../src/data/sync.ts";
import {
  eventBuilder,
  FakeEngine,
  frame,
  PROJECT,
  registered,
  SECRET,
  tick,
} from "./fake-engine.ts";

// roborev 5597: a sync loop that was stopped (StrictMode remount, session change) must not touch
// the shared store again, even when its in-flight request resolves late or its old stream still
// delivers bytes. The fake fetches below deliberately ignore the abort signal, like a response
// whose body is already on its way when stop() is called.

const NOW = Date.parse("2026-10-30T10:30:00Z");
const encoder = new TextEncoder();
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function options(store: ReturnType<typeof createDataStore>, fetch: typeof globalThis.fetch) {
  return {
    store,
    projectId: PROJECT,
    secret: SECRET,
    fetch,
    sleep: async () => {
      await tick();
    },
  };
}

describe("a stopped sync loop leaves the store alone", () => {
  it("does not overwrite the store with a snapshot that resolves after a new loop took over", async () => {
    const emit = eventBuilder();
    const events = registered(emit, "a1", "a2", "a3");
    const engine = new FakeEngine(events.slice(0, 2));
    const gate = deferred();
    let snapshotCalls = 0;
    // Loop A's snapshot is read at cursor 2 but delivered only when the gate opens.
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await engine.fetch(input, init);
      if (String(input).includes("/snapshot") && ++snapshotCalls === 1) await gate.promise;
      return response;
    };

    const store = createDataStore({ now: () => NOW });
    const cursors: number[] = [];
    store.subscribe((s, prev) => {
      if (s.cursor !== prev.cursor) cursors.push(s.cursor);
    });

    const a = startSync(options(store, fetch));
    await vi.waitFor(() => expect(engine.snapshotRequests).toHaveLength(1));
    const stoppedA = a.stop(); // cannot finish yet: its snapshot is still in flight
    const b = startSync(options(store, fetch));
    try {
      await vi.waitFor(() => {
        expect(store.getState().cursor).toBe(2);
        expect(store.getState().connection).toBe("live");
      });
      engine.publish(events[2] as never);
      await vi.waitFor(() => expect(store.getState().cursor).toBe(3));

      const before = cursors.length;
      gate.resolve(); // A's stale snapshot (cursor 2) arrives now
      await settle();

      expect(cursors.slice(before)).toEqual([]); // the store never moved back or re-applied
      expect(store.getState().cursor).toBe(3);
      expect(store.getState().agents.map((agent) => agent.id)).toEqual(["a1", "a2", "a3"]);
      expect(engine.streamRequests).toHaveLength(1); // A did not go on to open its own stream
    } finally {
      gate.resolve();
      await b.stop();
      void stoppedA;
    }
  });

  it("does not mark the connection live when the stream response arrives after stop", async () => {
    const emit = eventBuilder();
    const events = registered(emit, "a1", "a2", "a3");
    const engine = new FakeEngine(events.slice(0, 2));
    const gate = deferred();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamRequested = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (!String(input).includes("/events")) return engine.fetch(input, init);
      streamRequested = true;
      await gate.promise;
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });
      return new Response(body, { status: 200 });
    };

    const store = createDataStore({ now: () => NOW });
    const connections: string[] = [];
    store.subscribe((s, prev) => {
      if (s.connection !== prev.connection) connections.push(s.connection);
    });

    const sync = startSync(options(store, fetch));
    await vi.waitFor(() => expect(streamRequested).toBe(true));
    expect(store.getState().cursor).toBe(2);
    const stopped = sync.stop();
    try {
      gate.resolve(); // the stream opens after the loop was told to stop
      await vi.waitFor(() => expect(controller).toBeDefined());
      try {
        controller?.enqueue(encoder.encode(frame("event", events[2], 3)));
      } catch {
        // The loop cancelled the body: exactly what it should do.
      }
      await settle();

      expect(connections).not.toContain("live");
      expect(store.getState().connection).toBe("connecting");
      expect(store.getState().cursor).toBe(2);
    } finally {
      try {
        controller?.close();
      } catch {
        // already cancelled
      }
      void stopped;
    }
  });

  it("does not apply a frame that an already open stream delivers after stop", async () => {
    const emit = eventBuilder();
    const events = registered(emit, "a1", "a2", "a3");
    const engine = new FakeEngine(events.slice(0, 2));
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (!String(input).includes("/events")) return engine.fetch(input, init);
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });
      return new Response(body, { status: 200 });
    };

    const store = createDataStore({ now: () => NOW });
    const sync = startSync(options(store, fetch));
    await vi.waitFor(() => {
      expect(store.getState().cursor).toBe(2);
      expect(store.getState().connection).toBe("live");
    });
    const stopped = sync.stop();
    try {
      try {
        controller?.enqueue(encoder.encode(frame("event", events[2], 3)));
      } catch {
        // The loop cancelled the body: exactly what it should do.
      }
      await settle();

      expect(store.getState().cursor).toBe(2);
      expect(store.getState().agents.map((agent) => agent.id)).toEqual(["a1", "a2"]);
    } finally {
      try {
        controller?.close();
      } catch {
        // already cancelled
      }
      void stopped;
    }
  });
});
