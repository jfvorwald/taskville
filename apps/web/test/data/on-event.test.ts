import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce, type StoredEnvelope } from "../../src/data/domain.ts";
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

// `store.onEvent(listener)` hands the UI the raw events (M3.13 celebrations need them, the reduced
// state alone loses the "what just happened"). Called once per event after it has been reduced
// into state; never for snapshot loads, nor for frames the sync loop skips; returns an unsubscribe.

const NOW = Date.parse("2026-10-30T10:30:00Z");

function freshStore() {
  const store = createDataStore({ now: () => NOW });
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(initialState(PROJECT));
  return store;
}

describe("onEvent on the store", () => {
  it("calls the listener once per applied event, in order, with the stored envelope", () => {
    const emit = eventBuilder();
    const store = freshStore();
    const seen: StoredEnvelope[] = [];
    store.onEvent((event) => seen.push(event));

    const events = registered(emit, "a1", "a2", "a3");
    for (const event of events) store.getState().applyEvent(event);

    expect(seen).toEqual(events);
    expect(seen.map((e) => e.ingestSequence)).toEqual([1, 2, 3]);
  });

  it("calls the listener after the event is reduced into state", () => {
    const emit = eventBuilder();
    const store = freshStore();
    const observed: Array<{ cursor: number; agents: string[] }> = [];
    store.onEvent(() => {
      const s = store.getState();
      observed.push({ cursor: s.cursor, agents: s.agents.map((a) => a.id) });
    });

    for (const event of registered(emit, "a1", "a2")) store.getState().applyEvent(event);

    expect(observed).toEqual([
      { cursor: 1, agents: ["a1"] },
      { cursor: 2, agents: ["a1", "a2"] },
    ]);
  });

  it("does not call the listener when a snapshot is loaded", () => {
    const emit = eventBuilder();
    const store = createDataStore({ now: () => NOW });
    const listener = vi.fn();
    store.onEvent(listener);

    store.getState().reset(PROJECT);
    // A snapshot that already contains two events' worth of state.
    store
      .getState()
      .applySnapshotState(registered(emit, "a1", "a2").reduce(reduce, initialState(PROJECT)));

    expect(store.getState().cursor).toBe(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not call the listener when applying the event fails", () => {
    const emit = eventBuilder();
    const store = createDataStore({ now: () => NOW }); // no snapshot yet: applyEvent throws
    const listener = vi.fn();
    store.onEvent(listener);

    expect(() => store.getState().applyEvent(emit("agent.registered", "a1"))).toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops calling a listener once it unsubscribes, and leaves the others alone", () => {
    const emit = eventBuilder();
    const store = freshStore();
    const kept = vi.fn();
    const dropped = vi.fn();
    store.onEvent(kept);
    const unsubscribe = store.onEvent(dropped);

    store.getState().applyEvent(emit("agent.registered", "a1"));
    unsubscribe();
    unsubscribe(); // idempotent
    store.getState().applyEvent(emit("agent.registered", "a2"));

    expect(dropped).toHaveBeenCalledTimes(1);
    expect(kept).toHaveBeenCalledTimes(2);
  });

  it("applies the state and still calls the other listeners when a listener throws", () => {
    const emit = eventBuilder();
    const store = freshStore();
    const before = vi.fn();
    const after = vi.fn();
    store.onEvent(before);
    store.onEvent(() => {
      throw new Error("listener bug");
    });
    store.onEvent(after);

    expect(() => store.getState().applyEvent(emit("agent.registered", "a1"))).not.toThrow();

    expect(store.getState().cursor).toBe(1);
    expect(store.getState().agents.map((a) => a.id)).toEqual(["a1"]);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("onEvent through the sync loop", () => {
  function setup(engine: FakeEngine) {
    const store = createDataStore({ now: () => NOW });
    const seen: number[] = [];
    store.onEvent((event) => seen.push(event.ingestSequence));
    const sync = startSync({
      store,
      projectId: PROJECT,
      secret: SECRET,
      fetch: engine.fetch,
      sleep: async () => {
        await tick();
      },
    });
    return { store, sync, seen };
  }

  const settled = (store: ReturnType<typeof createDataStore>, cursor: number) =>
    vi.waitFor(() => {
      expect(store.getState().cursor).toBe(cursor);
      expect(store.getState().connection).toBe("live");
    });

  let running: { stop(): Promise<void> } | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it("reports streamed events but not the events already inside the snapshot", async () => {
    const emit = eventBuilder();
    const engine = new FakeEngine(registered(emit, "a1", "a2"));
    const { store, sync, seen } = setup(engine);
    running = sync;
    await settled(store, 2);
    expect(seen).toEqual([]);

    engine.publish(...registered(emit, "a3", "a4"));
    await settled(store, 4);
    expect(seen).toEqual([3, 4]);
  });

  it("reports the backlog replayed on resume exactly once", async () => {
    const emit = eventBuilder();
    const engine = new FakeEngine(registered(emit, "a1"));
    const { store, sync, seen } = setup(engine);
    running = sync;
    await settled(store, 1);

    engine.drop();
    engine.append(...registered(emit, "a2", "a3"));
    await settled(store, 3);
    expect(seen).toEqual([2, 3]);
  });

  it("does not report a duplicate frame at or below the cursor", async () => {
    const emit = eventBuilder();
    const events = registered(emit, "a1", "a2", "a3");
    const engine = new FakeEngine(events.slice(0, 2));
    const { store, sync, seen } = setup(engine);
    running = sync;
    await settled(store, 2);

    engine.send(frame("event", events[1], 2)); // a replay of sequence 2
    engine.publish(events[2] as never);
    await settled(store, 3);
    expect(seen).toEqual([3]);
  });

  it("does not report a skipped-sequence frame, nor the events a resnapshot loads", async () => {
    const emit = eventBuilder();
    const events = registered(emit, "a1", "a2", "a3", "a4");
    const engine = new FakeEngine(events.slice(0, 2));
    const { store, sync, seen } = setup(engine);
    running = sync;
    await settled(store, 2);

    engine.append(events[2] as never); // sequence 3 never reaches the stream
    engine.send(frame("event", events[3], 4)); // sequence 4 arrives out of order
    await vi.waitFor(() => expect(engine.snapshotRequests).toHaveLength(2));
    await settled(store, 3);
    expect(seen).toEqual([]);
  });

  it("keeps syncing when a listener throws: no resnapshot, state and cursor advance", async () => {
    const emit = eventBuilder();
    const engine = new FakeEngine(registered(emit, "a1"));
    const { store, sync } = setup(engine);
    running = sync;
    store.onEvent(() => {
      throw new Error("listener bug");
    });
    await settled(store, 1);

    engine.publish(...registered(emit, "a2", "a3"));
    await settled(store, 3);
    expect(engine.snapshotRequests).toHaveLength(1); // a bad listener must not force a resnapshot
    expect(store.getState().agents.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });
});
