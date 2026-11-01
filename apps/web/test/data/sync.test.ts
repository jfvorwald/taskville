import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProjectState, projectStateHash } from "../../src/data/domain.ts";
import { createDataStore } from "../../src/data/store.ts";
import { startSync } from "../../src/data/sync.ts";
import { SESSION_HEADER } from "../../src/pairing/pair.ts";
import {
  eventBuilder,
  FakeEngine,
  frame,
  PROJECT,
  registered,
  SECRET,
  stateHashAt,
  tick,
} from "./fake-engine.ts";

const NOW = Date.parse("2026-10-30T10:30:00Z");

function setup(engine: FakeEngine) {
  const store = createDataStore({ now: () => NOW });
  const connections: string[] = [];
  store.subscribe((s, prev) => {
    if (s.connection !== prev.connection) connections.push(s.connection);
  });
  const delays: number[] = [];
  const sync = startSync({
    store,
    projectId: PROJECT,
    secret: SECRET,
    fetch: engine.fetch,
    sleep: async (ms) => {
      delays.push(ms);
      await tick();
    },
  });
  return { store, sync, connections, delays };
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

describe("snapshot then stream", () => {
  it("loads the snapshot, then streams after its cursor, sending the session header on both", async () => {
    const emit = eventBuilder();
    const engine = new FakeEngine(registered(emit, "a1", "a2"));
    const { store, sync } = setup(engine);
    running = sync;

    await settled(store, 2);
    expect(Object.keys(store.getState().state?.agents ?? {})).toEqual(["a1", "a2"]);
    expect(engine.snapshotRequests).toHaveLength(1);
    expect(engine.streamRequests.map((r) => r.url)).toEqual([
      `/v1/projects/${PROJECT}/events?after=2`,
    ]);
    for (const request of engine.requests) {
      expect(request.headers.get(SESSION_HEADER)).toBe(SECRET);
    }

    engine.publish(...registered(emit, "a3"));
    await settled(store, 3);
    expect(store.getState().agents.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("gap-free resume", () => {
  it("resumes after the last applied sequence with no gap and no duplicate", async () => {
    const emit = eventBuilder();
    const engine = new FakeEngine(registered(emit, "a1", "a2"));
    const { store, sync } = setup(engine);
    running = sync;
    await settled(store, 2);

    // The connection drops; two events land while the viewer is away.
    engine.drop();
    engine.append(...registered(emit, "a3", "a4"));
    await settled(store, 4);

    expect(engine.snapshotRequests).toHaveLength(1); // resumed, did not resnapshot
    expect(engine.streamRequests.map((r) => r.url)).toEqual([
      `/v1/projects/${PROJECT}/events?after=2`,
      `/v1/projects/${PROJECT}/events?after=2`,
    ]);
    // Same state as replaying the whole log, so nothing was dropped or applied twice.
    expect(store.getState().state).not.toBeNull();
    expect(projectStateHash(store.getState().state as ProjectState)).toBe(stateHashAt(engine.log));
  });

  it("ignores a frame at or below the cursor", async () => {
    const emit = eventBuilder();
    const events = registered(emit, "a1", "a2", "a3");
    const engine = new FakeEngine(events.slice(0, 2));
    const { store, sync } = setup(engine);
    running = sync;
    await settled(store, 2);

    engine.send(frame("event", events[1], 2)); // a replay of sequence 2
    engine.publish(events[2] as never);
    await settled(store, 3);
    expect(engine.snapshotRequests).toHaveLength(1);
    expect(store.getState().agents.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("takes a fresh snapshot when a frame skips a sequence", async () => {
    const emit = eventBuilder();
    const events = registered(emit, "a1", "a2", "a3", "a4");
    const engine = new FakeEngine(events.slice(0, 2));
    const { store, sync } = setup(engine);
    running = sync;
    await settled(store, 2);

    engine.append(events[2] as never); // sequence 3 never reaches the stream
    engine.send(frame("event", events[3], 4));
    await vi.waitFor(() => expect(engine.snapshotRequests).toHaveLength(2));
    await settled(store, 3);
    expect(engine.streamRequests.at(-1)?.url).toBe(`/v1/projects/${PROJECT}/events?after=3`);
  });
});

describe("resnapshot", () => {
  it.each(["slow_consumer", "cursor_ahead_of_head", "reducer_rebuilt"])(
    "on %s it replaces the state from a new snapshot and resumes from its cursor",
    async (reason) => {
      const emit = eventBuilder();
      const engine = new FakeEngine(registered(emit, "a1", "a2"));
      const { store, sync } = setup(engine);
      running = sync;
      await settled(store, 2);

      engine.append(...registered(emit, "a3", "a4")); // missed: the client was cut off
      engine.resnapshot(reason);
      await vi.waitFor(() => expect(engine.snapshotRequests).toHaveLength(2));
      await settled(store, 4);

      expect(engine.streamRequests.at(-1)?.url).toBe(`/v1/projects/${PROJECT}/events?after=4`);
      expect(store.getState().agents.map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4"]);

      engine.publish(...registered(emit, "a5"));
      await settled(store, 5);
    },
  );
});

describe("stale flag", () => {
  it("keeps the last view and marks it stale while disconnected, then live again", async () => {
    const emit = eventBuilder();
    const engine = new FakeEngine(registered(emit, "a1", "a2"));
    const { store, sync, connections, delays } = setup(engine);
    running = sync;
    await settled(store, 2);

    engine.down = true;
    engine.drop();
    await vi.waitFor(() => expect(delays.length).toBeGreaterThan(1)); // retried and backed off
    expect(store.getState().connection).toBe("stale");
    expect(store.getState().agents.map((a) => a.id)).toEqual(["a1", "a2"]); // view kept
    expect(delays.at(-1)).toBeGreaterThan(delays[0] ?? 0); // backoff grows

    engine.down = false;
    engine.append(...registered(emit, "a3"));
    await settled(store, 3);
    expect(connections).toEqual(["live", "stale", "live"]);
  });

  it("is stale when the server ends the stream cleanly", async () => {
    const emit = eventBuilder();
    const engine = new FakeEngine(registered(emit, "a1"));
    const { store, sync, connections } = setup(engine);
    running = sync;
    await settled(store, 1);
    engine.end();
    await vi.waitFor(() => expect(connections).toContain("stale"));
    await settled(store, 1);
  });

  it("is not live before the first snapshot", async () => {
    const engine = new FakeEngine([]);
    engine.down = true;
    const { store, sync } = setup(engine);
    running = sync;
    await vi.waitFor(() => expect(engine.requests.length).toBeGreaterThan(1));
    expect(store.getState().state).toBeNull();
    expect(store.getState().connection).toBe("connecting");
  });
});

describe("failures that do not retry", () => {
  it("stops with `unauthorized` on 401 and keeps the last view", async () => {
    const emit = eventBuilder();
    const engine = new FakeEngine(registered(emit, "a1"));
    const { store, sync } = setup(engine);
    running = sync;
    await settled(store, 1);

    engine.revoked = true;
    engine.drop();
    await vi.waitFor(() => expect(store.getState().connection).toBe("failed"));
    expect(store.getState().error).toBe("unauthorized");
    expect(store.getState().agents).toHaveLength(1);
    const seen = engine.requests.length;
    await tick();
    await tick();
    expect(engine.requests).toHaveLength(seen);
  });

  it("fails with `reducer_mismatch` when the engine's reducer version differs", async () => {
    const engine = new FakeEngine([]);
    engine.reducerVersion = 999;
    const { store, sync } = setup(engine);
    running = sync;
    await vi.waitFor(() => expect(store.getState().connection).toBe("failed"));
    expect(store.getState().error).toBe("reducer_mismatch");
    expect(store.getState().state).toBeNull();
  });
});

describe("stop", () => {
  it("cancels the open stream and stops requesting", async () => {
    const engine = new FakeEngine([]);
    const { store, sync } = setup(engine);
    await settled(store, 0);
    await sync.stop();
    expect(engine.openStreams).toBe(0);
    const seen = engine.requests.length;
    await tick();
    expect(engine.requests).toHaveLength(seen);
  });
});
