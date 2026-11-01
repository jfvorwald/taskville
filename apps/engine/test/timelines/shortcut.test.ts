import {
  type ProjectState,
  projectStateHash,
  REDUCER_VERSION,
  replay,
} from "@taskville/domain/reducer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLog } from "./day-log.ts";
import { bootInProcess, dayEvents, type Engine, getJson, useDbPath } from "./helpers.ts";

// The head shortcut of GET /v1/timelines/:id/state (M6.01 review round 3).
//
// Pinned contract:
// - At the head the route may reuse the stored projection instead of replaying, but only when it
//   is current: written by this REDUCER_VERSION. A projection written by another reducer version
//   is never served; the route replays the log and answers with the replayed state and hash.
// - A current projection is reused (no replay), so the common "show me now" read is cheap.
//
// `stored.head === at` (the other half of the guard) cannot be driven from outside:
// writeProjection refuses a head that is not the project head, and the shortcut only runs at the
// head. So only the version half is pinned here.

const replayCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@taskville/domain/reducer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@taskville/domain/reducer")>();
  return {
    ...actual,
    replay: (...args: Parameters<typeof actual.replay>) => {
      replayCalls.count += 1;
      return actual.replay(...args);
    },
  };
});

const dbPath = useDbPath();
let engine: Engine | undefined;
let app: ReturnType<typeof bootInProcess>["app"];
const events = dayEvents().slice(0, 40);

beforeEach(() => {
  const booted = bootInProcess(dbPath());
  engine = booted.engine;
  app = booted.app;
  seedLog(engine.storage, events);
});
afterEach(() => {
  engine?.close();
  engine = undefined;
});

interface StateBody {
  at: number;
  reducerVersion: number;
  stateHash: string;
  state: ProjectState;
}

describe("head shortcut", () => {
  it("does not serve a stored projection written by another reducer version: it replays", async () => {
    const storage = (engine as Engine).storage;
    const head = storage.head("demo") ?? 0;
    expect(head).toBe(events.length);
    const truth = replay("demo", events);
    const doctored = { ...truth, projectId: "doctored", reducerVersion: REDUCER_VERSION - 1 };
    storage.transaction((tx) =>
      tx.writeProjection({
        projectId: "demo",
        reducerVersion: REDUCER_VERSION - 1,
        head,
        state: doctored,
      }),
    );
    expect(storage.projection("demo")?.reducerVersion).toBe(REDUCER_VERSION - 1);

    replayCalls.count = 0;
    const { status, body } = await getJson<StateBody>(
      app,
      `/v1/timelines/live:demo/state?at=${head}`,
    );
    expect(status).toBe(200);
    expect(replayCalls.count).toBeGreaterThan(0);
    expect(body.at).toBe(head);
    expect(body.state.projectId).toBe("demo");
    expect(body.state).toEqual(JSON.parse(JSON.stringify(truth)));
    expect(body.reducerVersion).toBe(REDUCER_VERSION);
    expect(body.stateHash).toBe(projectStateHash(truth));
    expect(body.stateHash.startsWith(`${REDUCER_VERSION}:`)).toBe(true);
  });

  it("also replays for a projection from a newer reducer version", async () => {
    const storage = (engine as Engine).storage;
    const head = storage.head("demo") ?? 0;
    const truth = replay("demo", events);
    storage.transaction((tx) =>
      tx.writeProjection({
        projectId: "demo",
        reducerVersion: REDUCER_VERSION + 1,
        head,
        state: { ...truth, projectId: "doctored", reducerVersion: REDUCER_VERSION + 1 },
      }),
    );
    const { body } = await getJson<StateBody>(app, `/v1/timelines/live:demo/state?at=${head}`);
    expect(body.state.projectId).toBe("demo");
    expect(body.stateHash).toBe(projectStateHash(truth));
  });

  it("reuses a current projection at the head without replaying, and answers what it holds", async () => {
    const storage = (engine as Engine).storage;
    const head = storage.head("demo") ?? 0;
    const stored = storage.projection<ProjectState>("demo");
    expect(stored?.reducerVersion).toBe(REDUCER_VERSION);
    expect(stored?.head).toBe(head);
    const truth = replay("demo", events);

    replayCalls.count = 0;
    const { status, body } = await getJson<StateBody>(
      app,
      `/v1/timelines/live:demo/state?at=${head}`,
    );
    expect(status).toBe(200);
    expect(replayCalls.count).toBe(0);
    expect(body.stateHash).toBe(stored?.stateHash);
    expect(body.stateHash).toBe(projectStateHash(truth));
    expect(body.state).toEqual(JSON.parse(JSON.stringify(truth)));
  });

  it("control: a position before the head is always a replay, whatever is stored", async () => {
    const before = events.length - 5;
    replayCalls.count = 0;
    const { body } = await getJson<StateBody>(app, `/v1/timelines/live:demo/state?at=${before}`);
    expect(replayCalls.count).toBeGreaterThan(0);
    expect(body.stateHash).toBe(projectStateHash(replay("demo", events.slice(0, before))));
  });
});
