import { afterEach, describe, expect, it } from "vitest";
import {
  initialState,
  type ProjectState,
  projectStateHash,
  REDUCER_VERSION,
  reduce,
} from "../../../src/data/domain.ts";
import { createDataStore } from "../../../src/data/store.ts";
import { SESSION_HEADER } from "../../../src/pairing/pair.ts";
import { eventBuilder, PROJECT, SECRET } from "../../data/fake-engine.ts";

// Proposed M6.02 seam, mirroring createDataStore's vanilla Zustand API:
// createHistoryStore({ liveStore, timelineId, secret, fetch, now }) -> StoreApi + dispose().
// getState(): { mode: "live" | "history", state: ProjectState | null,
//   time: number | null, playing: boolean, rate: 1 | 10 | 60 | 600,
//   seek(epochMs): Promise<void>, play(), pause(), setRate(rate), tick(): Promise<void>,
//   returnLive() }.
// `now` measures elapsed milliseconds. The caller drives tick (later UI wiring owns scheduling).
// seek reconstructs through M6.01's state route, independently of the live DataStore.
// Superseded/cancelled seeks settle without publishing; dispose is idempotent.
// The source module is intentionally absent in the red phase, not a misspelled existing import.

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing test fixture value");
  return value;
}

const START = Date.parse("2026-10-30T10:00:00Z");
const TIMELINE = `live:${PROJECT}`;
const emit = eventBuilder();
const LOG = [
  emit("agent.registered", "a1"),
  emit("agent.connected", "a1"),
  emit("session.turn_failed", "a1"),
  emit("agent.disconnected", "a1"),
].map((event, index) => ({
  ...event,
  receivedAt: new Date(START + required([0, 1_000, 30_000, 1_200_000][index])).toISOString(),
}));

// Resolve the greatest received sequence, as specified by the timeline HTTP contract.
function stateAt(time: number): ProjectState {
  const cursor =
    LOG.filter((event) => Date.parse(event.receivedAt) <= time).at(-1)?.ingestSequence ?? 0;
  return LOG.slice(0, cursor).reduce(reduce, initialState(PROJECT));
}

function bodyAt(time: number) {
  const state = stateAt(time);
  return {
    timelineId: TIMELINE,
    at: state.head,
    cursor: state.head,
    reducerVersion: REDUCER_VERSION,
    stateHash: projectStateHash(state),
    state,
    attention: [],
    // Deliberately far from replay time: computedAt is not the replay clock.
    computedAt: "2026-11-01T12:00:00Z",
  };
}

interface Request {
  url: URL;
  headers: Headers;
  signal: AbortSignal | null | undefined;
  resolve(response?: Response): void;
}

function timelineEngine() {
  const requests: Request[] = [];
  let deferred = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://127.0.0.1");
    expect(init?.method ?? "GET").toBe("GET");
    expect(decodeURIComponent(url.pathname)).toBe(`/v1/timelines/${TIMELINE}/state`);
    const at = url.searchParams.get("at");
    expect(at).not.toBeNull();
    // A JS epoch number alone is a sequence to M6.01, so the wire value must be ISO.
    expect(at).toBe(new Date(Date.parse(required(at))).toISOString());
    const headers = new Headers(init?.headers);
    expect(headers.get(SESSION_HEADER)).toBe(SECRET);
    return new Promise<Response>((resolve) => {
      const request = {
        url,
        headers,
        signal: init?.signal,
        resolve: (response?: Response) =>
          resolve(response ?? Response.json(bodyAt(Date.parse(required(at))))),
      };
      requests.push(request);
      // Ignore abort intentionally: late responses must still be fenced by the controller.
      if (!deferred) request.resolve();
    });
  };
  return {
    requests,
    fetch: fetcher,
    defer: () => {
      deferred = true;
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(withLiveSnapshot = true) {
  const { createHistoryStore } = await import("../../../src/history/state/store.ts");
  let elapsed = 0;
  const liveStore = createDataStore({ now: () => START + 1_200_000 });
  liveStore.getState().reset(PROJECT);
  if (withLiveSnapshot) {
    liveStore.getState().applySnapshotState(stateAt(START + 30_000));
    liveStore.getState().setConnection("live");
  }
  const engine = timelineEngine();
  const history = createHistoryStore({
    liveStore,
    timelineId: TIMELINE,
    secret: SECRET,
    fetch: engine.fetch,
    now: () => elapsed,
  });
  cleanups.push(() => history.dispose());
  return {
    history,
    liveStore,
    engine,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

// This control also verifies the fixture's real reducer states and current version without
// loading the proposed controller. No cloned reducer, hardcoded version, or new endpoints.
describe("timeline fixture contract", () => {
  it("has distinct real states at empty, registered, connected, failed and disconnected positions", () => {
    const states = [-1, 0, 1_000, 30_000, 1_200_000].map((offset) => stateAt(START + offset));
    expect(states.map((state) => state.head)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(states.map(projectStateHash)).size).toBe(5);
    expect(states.every((state) => state.reducerVersion === REDUCER_VERSION)).toBe(true);
  });

  it("serves the existing authenticated M6.01 state response shape", async () => {
    const engine = timelineEngine();
    const time = START + 30_000;
    const response = await engine.fetch(
      `/v1/timelines/${encodeURIComponent(TIMELINE)}/state?at=${encodeURIComponent(new Date(time).toISOString())}`,
      { headers: { [SESSION_HEADER]: SECRET } },
    );
    expect(await response.json()).toEqual(bodyAt(time));
    expect(engine.requests).toHaveLength(1);
  });
});

describe("history state", () => {
  it("starts live and follows the current DataStore snapshot without fetching history", async () => {
    const { history, liveStore, engine } = await setup();
    expect(history.getState()).toMatchObject({ mode: "live", playing: false, time: null, rate: 1 });
    expect(history.getState().state).toBe(liveStore.getState().state);
    liveStore.getState().applyEvent(required(LOG[3]));
    expect(history.getState().state).toBe(liveStore.getState().state);
    expect(engine.requests).toHaveLength(0);
  });

  it("seeks directly while paused, forwards and backwards, including before the first event", async () => {
    const { history, liveStore, engine, advance } = await setup();
    const liveBefore = liveStore.getState();
    for (const offset of [1_000, 30_000, 0, -1, 1_200_000]) {
      const time = START + offset;
      await history.getState().seek(time);
      expect(history.getState()).toMatchObject({ mode: "history", time, playing: false });
      expect(history.getState().state).toEqual(stateAt(time));
    }
    expect(engine.requests).toHaveLength(5);
    expect(liveStore.getState()).toBe(liveBefore);
    advance(90_000);
    await history.getState().tick();
    expect(history.getState().time).toBe(START + 1_200_000);
    expect(engine.requests).toHaveLength(5);
  });

  it.each([1, 10, 60, 600] as const)(
    "plays at %ix using only elapsed injected time",
    async (rate) => {
      const { history, advance } = await setup();
      await history.getState().seek(START);
      history.getState().setRate(rate);
      history.getState().play();
      advance(1_000);
      await history.getState().tick();
      expect(history.getState()).toMatchObject({ time: START + rate * 1_000, playing: true, rate });
      expect(history.getState().state).toEqual(stateAt(START + rate * 1_000));
      history.getState().pause();
      advance(50_000);
      await history.getState().tick();
      expect(history.getState().time).toBe(START + rate * 1_000);
      history.getState().play();
      advance(500);
      await history.getState().tick();
      expect(history.getState().time).toBe(START + rate * 1_500);
      expect(history.getState().state).toEqual(stateAt(START + rate * 1_500));
    },
  );

  it("changes speed at the current position without jumping the clock", async () => {
    const { history, advance } = await setup();
    await history.getState().seek(START);
    history.getState().play();
    advance(1_000);
    await history.getState().tick();
    history.getState().setRate(60);
    expect(history.getState().time).toBe(START + 1_000);
    advance(500);
    await history.getState().tick();
    expect(history.getState().time).toBe(START + 31_000);
    expect(history.getState().state).toEqual(stateAt(START + 31_000));
  });

  it("preserves an explicit deferred seek when a playback tick arrives", async () => {
    const { history, engine, advance } = await setup();
    await history.getState().seek(START);
    history.getState().play();
    engine.defer();
    const seek = history.getState().seek(START + 30_000);
    const request = required(engine.requests[1]);
    advance(1_000);
    const tick = history.getState().tick();
    // Settle every read even against the pre-fix controller, which starts another fetch.
    for (const pending of engine.requests.slice(1)) pending.resolve();
    await Promise.all([seek, tick]);
    expect(history.getState()).toMatchObject({ time: START + 30_000, playing: true });
    expect(history.getState().state).toEqual(stateAt(START + 30_000));
    expect(request.signal?.aborted).toBe(false);
    expect(engine.requests).toHaveLength(2);
    // Explicit seek completion anchors playback at the requested position.
    advance(1_000);
    const next = history.getState().tick();
    required(engine.requests.at(-1)).resolve();
    await next;
    expect(history.getState().time).toBe(START + 31_000);
  });

  it("publishes a pending playback read despite repeated overlapping ticks", async () => {
    const { history, engine, advance } = await setup();
    await history.getState().seek(START);
    history.getState().play();
    engine.defer();
    advance(1_000);
    const first = history.getState().tick();
    const request = required(engine.requests[1]);
    const overlaps: Promise<void>[] = [];
    for (let index = 0; index < 3; index += 1) {
      advance(100);
      overlaps.push(history.getState().tick());
    }
    request.resolve();
    await first;
    const published = history.getState();
    const aborted = request.signal?.aborted;
    const requestCount = engine.requests.length;
    for (const pending of engine.requests.slice(2)) pending.resolve();
    await Promise.all(overlaps);
    expect(published.time).toBe(START + 1_000);
    expect(published.state).toEqual(stateAt(START + 1_000));
    expect(aborted).toBe(false);
    expect(requestCount).toBe(2);
  });

  it("recovers elapsed time from skipped ticks on the next tick after publication", async () => {
    const { history, engine, advance } = await setup();
    await history.getState().seek(START);
    history.getState().setRate(10);
    history.getState().play();
    engine.defer();
    advance(100);
    const first = history.getState().tick();
    advance(2_000);
    const skipped = history.getState().tick();
    required(engine.requests[1]).resolve();
    await first;
    const completedTime = history.getState().time;
    // No clock advance here: all 2,000 ms elapsed while the first read was pending.
    const next = history.getState().tick();
    const nextRequest = required(engine.requests.at(-1));
    for (const pending of engine.requests.slice(2)) pending.resolve();
    await Promise.all([skipped, next]);
    expect([completedTime, history.getState().time]).toEqual([START + 1_000, START + 21_000]);
    expect(nextRequest.url.searchParams.get("at")).toBe(new Date(START + 21_000).toISOString());
    expect(history.getState().state).toEqual(stateAt(START + 21_000));
    // The recovered interval must not be counted a second time.
    advance(900);
    const later = history.getState().tick();
    required(engine.requests.at(-1)).resolve();
    await later;
    expect(history.getState().time).toBe(START + 30_000);
    expect(history.getState().state).toEqual(stateAt(START + 30_000));
  });

  it.each(["HTTP", "JSON"] as const)(
    "retains the published view after a rejected %s response and permits a later seek",
    async (failure) => {
      const { history, engine } = await setup();
      await history.getState().seek(START + 1_000);
      const before = history.getState();
      engine.defer();
      const failed = history.getState().seek(START + 30_000);
      const rejection = expect(failed).rejects.toThrow(
        failure === "HTTP" ? "HTTP 503" : SyntaxError,
      );
      required(engine.requests[1]).resolve(
        failure === "HTTP" ? new Response(null, { status: 503 }) : new Response("{"),
      );
      await rejection;
      expect(history.getState()).toBe(before);
      const recovery = history.getState().seek(START + 1_200_000);
      required(engine.requests[2]).resolve();
      await recovery;
      expect(history.getState()).toMatchObject({
        mode: "history",
        time: START + 1_200_000,
        playing: false,
      });
      expect(history.getState().state).toEqual(stateAt(START + 1_200_000));
    },
  );

  it("keeps live events underneath replay and returns synchronously to the latest snapshot", async () => {
    const { history, liveStore, engine } = await setup();
    await history.getState().seek(START);
    const replay = history.getState().state;
    liveStore.getState().applyEvent(required(LOG[3])); // The same entry point used by the SSE sync loop.
    expect(liveStore.getState().cursor).toBe(4);
    expect(liveStore.getState().connection).toBe("live");
    expect(history.getState().state).toBe(replay);
    const requestCount = engine.requests.length;
    history.getState().returnLive();
    expect(history.getState()).toMatchObject({ mode: "live", playing: false, time: null });
    expect(history.getState().state).toBe(liveStore.getState().state);
    expect(engine.requests).toHaveLength(requestCount);
    // A resnapshot received after return also reaches the displayed live view.
    liveStore.getState().applySnapshotState(initialState(PROJECT));
    expect(history.getState().state).toBe(liveStore.getState().state);
  });

  it("ignores an older seek response that finishes after a newer seek", async () => {
    const { history, engine } = await setup();
    engine.defer();
    const older = history.getState().seek(START);
    const newer = history.getState().seek(START + 30_000);
    expect(engine.requests).toHaveLength(2);
    required(engine.requests[1]).resolve();
    await newer;
    required(engine.requests[0]).resolve();
    await older;
    expect(history.getState().time).toBe(START + 30_000);
    expect(history.getState().state).toEqual(stateAt(START + 30_000));
  });

  it("fences an in-flight playback response when returning to live", async () => {
    const { history, liveStore, engine, advance } = await setup();
    await history.getState().seek(START);
    history.getState().play();
    engine.defer();
    advance(1_000);
    const pending = history.getState().tick();
    liveStore.getState().applyEvent(required(LOG[3]));
    history.getState().returnLive();
    required(engine.requests[1]).resolve();
    await pending;
    expect(history.getState()).toMatchObject({ mode: "live", time: null, playing: false });
    expect(history.getState().state).toBe(liveStore.getState().state);
  });

  it("clears replay on project reset and ignores the previous project's pending response", async () => {
    const { history, liveStore, engine } = await setup();
    await history.getState().seek(START);
    engine.defer();
    const pending = history.getState().seek(START + 30_000);
    liveStore.getState().reset("other");
    liveStore.getState().applySnapshotState(initialState("other"));
    required(engine.requests[1]).resolve();
    await pending;
    expect(history.getState()).toMatchObject({ mode: "live", time: null, playing: false });
    expect(history.getState().state).toBe(liveStore.getState().state);
    const count = engine.requests.length;
    await history.getState().tick();
    expect(engine.requests).toHaveLength(count);
  });

  it("fences a pending seek on same-project reset while live state is already null", async () => {
    const { history, liveStore, engine } = await setup(false);
    expect(liveStore.getState().state).toBeNull();
    engine.defer();
    const pending = history.getState().seek(START + 30_000);
    liveStore.getState().reset(PROJECT);
    expect(history.getState()).toMatchObject({ mode: "live", time: null, playing: false });
    expect(history.getState().state).toBe(liveStore.getState().state);
    let publications = 0;
    const unsubscribe = history.subscribe(() => {
      publications += 1;
    });
    required(engine.requests[0]).resolve();
    await pending;
    unsubscribe();
    expect(history.getState()).toMatchObject({ mode: "live", time: null, playing: false });
    expect(history.getState().state).toBe(liveStore.getState().state);
    expect(publications).toBe(0);
  });

  it("clears completed replay on same-project reset while live state remains null", async () => {
    const { history, liveStore, engine, advance } = await setup(false);
    await history.getState().seek(START + 1_000);
    history.getState().play();
    expect(history.getState()).toMatchObject({ mode: "history", playing: true });
    expect(liveStore.getState().state).toBeNull();
    liveStore.getState().reset(PROJECT);
    const afterReset = history.getState();
    advance(1_000);
    await history.getState().tick();
    expect(afterReset).toMatchObject({ mode: "live", time: null, playing: false });
    expect(afterReset.state).toBe(liveStore.getState().state);
    expect(history.getState()).toBe(afterReset);
    expect(engine.requests).toHaveLength(1);
  });

  it("preserves pending and completed replay across ordinary null-state notifications", async () => {
    const { history, liveStore, engine } = await setup(false);
    engine.defer();
    const time = START + 30_000;
    const pending = history.getState().seek(time);
    liveStore.getState().setConnection("stale");
    liveStore.getState().select("a1");
    expect(liveStore.getState().state).toBeNull();
    required(engine.requests[0]).resolve();
    await pending;
    expect(history.getState()).toMatchObject({ mode: "history", time, playing: false });
    expect(history.getState().state).toEqual(stateAt(time));
    history.getState().play();
    const replay = history.getState();
    liveStore.getState().setConnection("connecting");
    liveStore.getState().select(null);
    expect(liveStore.getState().state).toBeNull();
    expect(history.getState()).toBe(replay);
    expect(history.getState()).toMatchObject({ mode: "history", time, playing: true });
    expect(engine.requests).toHaveLength(1);
  });

  it("dispose stops publication from late seeks and detaches from the live store", async () => {
    const { history, liveStore, engine } = await setup();
    engine.defer();
    const pending = history.getState().seek(START);
    history.dispose();
    history.dispose();
    const disposed = history.getState();
    let notifications = 0;
    const unsubscribe = history.subscribe(() => {
      notifications += 1;
    });
    required(engine.requests[0]).resolve();
    await pending;
    liveStore.getState().applyEvent(required(LOG[3]));
    expect(history.getState()).toBe(disposed);
    expect(notifications).toBe(0);
    unsubscribe();
  });
});
