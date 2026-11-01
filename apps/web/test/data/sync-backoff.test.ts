import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataStore } from "../../src/data/store.ts";
import { startSync } from "../../src/data/sync.ts";
import { eventBuilder, FakeEngine, frame, PROJECT, SECRET, tick } from "./fake-engine.ts";

// The retry backoff must grow while the server keeps opening a stream that yields nothing.
// Opening a stream is not proof of a healthy connection: only an applied event is. Otherwise a
// server (or proxy) that accepts and immediately closes is retried with no delay in a tight loop.

type Script = "empty" | "event" | "resnapshot";

/**
 * The snapshot route is the fake engine's (empty log, cursor 0). The events route answers each
 * successive request from `script` (then "empty" forever): a stream that closes at once, a stream
 * that delivers one event (sequence 1) and closes, or a stream that sends `resnapshot` and closes.
 * The resnapshot case makes the loop refetch the snapshot, which is still empty.
 */
function scriptedFetch(engine: FakeEngine, script: readonly Script[]): typeof fetch {
  const emit = eventBuilder();
  const one = emit("agent.registered", "a1");
  let streams = 0;
  return async (input, init) => {
    const url = String(input);
    if (!url.includes("/events")) return engine.fetch(input, init);
    const kind = script[streams] ?? "empty";
    streams += 1;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        if (kind === "event") controller.enqueue(encoder.encode(frame("event", one, 1)));
        if (kind === "resnapshot") {
          controller.enqueue(encoder.encode(frame("resnapshot", { reason: "slow_consumer" })));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
}

function setup(script: readonly Script[]) {
  const engine = new FakeEngine([]);
  const store = createDataStore({ now: () => 0 });
  const delays: number[] = [];
  const sync = startSync({
    store,
    projectId: PROJECT,
    secret: SECRET,
    fetch: scriptedFetch(engine, script),
    sleep: async (ms) => {
      delays.push(ms);
      await tick();
    },
  });
  return { store, sync, delays };
}

let running: { stop(): Promise<void> } | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe("backoff resets only when a stream proves healthy", () => {
  it("grows strictly across consecutive streams that open and close with no events", async () => {
    const { sync, delays } = setup([]);
    running = sync;
    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(4));

    const first = delays.slice(0, 4);
    expect(first).toEqual([...first].sort((a, b) => a - b));
    expect(new Set(first).size).toBe(first.length); // strictly growing: no repeated delay
  });

  it("grows strictly while a stream keeps forcing a resnapshot without delivering events", async () => {
    const { sync, delays } = setup(["resnapshot", "resnapshot", "resnapshot", "resnapshot"]);
    running = sync;
    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(4));

    const first = delays.slice(0, 4);
    expect(first).toEqual([...first].sort((a, b) => a - b));
    expect(new Set(first).size).toBe(first.length);
  });

  it("returns to the base delay after a stream that applied an event, then grows again", async () => {
    const { store, sync, delays } = setup(["empty", "empty", "empty", "event"]);
    running = sync;
    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(6));

    expect(store.getState().cursor).toBe(1); // the event was applied
    const [d0, d1, d2, afterEvent, next, nextAgain] = delays as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    expect(d0).toBeLessThan(d1); // grew over the empty streams
    expect(d1).toBeLessThan(d2);
    expect(afterEvent).toBe(d0); // the event-bearing stream reset to the base delay
    expect(next).toBe(d1); // and growth starts over from the beginning
    expect(nextAgain).toBe(d2);
  });
});
