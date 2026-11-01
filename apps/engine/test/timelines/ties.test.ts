import { projectStateHash, replay } from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedLog } from "./day-log.ts";
import { bootInProcess, dayEvents, type Engine, getJson, useDbPath } from "./helpers.ts";

// Timestamp resolution when receivedAt has ties and steps back (M6.01 review round 3).
//
// The engine clock may repeat a millisecond or move backwards, so `receivedAt` is not sorted by
// sequence. Pinned contract (sequence is the record, time only selects a sequence):
// - `state?at=<ts>` is the GREATEST sequence whose receivedAt is at or before ts (0 when none).
// - `events?from=<ts>` starts at the FIRST sequence whose receivedAt is at or after ts, and
//   `events?to=<ts>` ends at the LAST sequence received at or before ts. Both are inclusive and
//   take no account of events between them whose time falls outside the window.
//
// Log (offsets in ms from T, by sequence): 1:0  2:1000  3:1000  4:3000  5:2000  6:2000
// 7:5000  8:4000. Two events tie at 1000, two at 2000, and 5 steps back behind 4.

const T = Date.parse("2026-03-01T00:00:00.000Z");
const OFFSETS = [0, 1000, 1000, 3000, 2000, 2000, 5000, 4000];
const iso = (offset: number) => encodeURIComponent(new Date(T + offset).toISOString());

const events: StoredEnvelope[] = dayEvents()
  .slice(0, OFFSETS.length)
  .map((e, i) => ({ ...e, receivedAt: new Date(T + (OFFSETS[i] ?? 0)).toISOString() }));

const dbPath = useDbPath();
let engine: Engine | undefined;
let app: ReturnType<typeof bootInProcess>["app"];
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
  cursor: number;
  stateHash: string;
}
interface PageBody {
  events: StoredEnvelope[];
  nextCursor: string | null;
}
const seqs = (list: readonly StoredEnvelope[]) => list.map((e) => e.ingestSequence);
const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

describe("timestamps with ties and a clock that steps back", () => {
  it("stores the log as built (receivedAt not sorted)", () => {
    const stored = [...(engine as Engine).storage.events("demo")];
    expect(stored.map((e) => e.receivedAt)).toEqual(events.map((e) => e.receivedAt));
  });

  it("state at a timestamp is the greatest sequence received at or before it", async () => {
    const want: Array<[number, number]> = [
      [-1, 0],
      [0, 1],
      [999, 1],
      [1000, 3],
      [1500, 3],
      [2000, 6],
      [2500, 6],
      [2999, 6],
      [3000, 6],
      [3999, 6],
      [4000, 8],
      [4999, 8],
      [5000, 8],
      [99_999, 8],
    ];
    for (const [offset, at] of want) {
      const { status, body } = await getJson<StateBody>(
        app,
        `/v1/timelines/live:demo/state?at=${iso(offset)}`,
      );
      expect(status, `+${offset}`).toBe(200);
      expect(body.at, `+${offset}`).toBe(at);
      expect(body.cursor, `+${offset}`).toBe(at);
      expect(body.stateHash, `+${offset}`).toBe(
        projectStateHash(replay("demo", events.slice(0, at))),
      );
    }
  });

  it("events from a timestamp start at the first sequence received at or after it", async () => {
    const want: Array<[number, number | null]> = [
      [-5000, 1],
      [0, 1],
      [1, 2],
      [1000, 2],
      [1001, 4],
      [2000, 4],
      [3000, 4],
      [3001, 7],
      [4000, 7],
      [5000, 7],
      [5001, null],
    ];
    for (const [offset, first] of want) {
      const { status, body } = await getJson<PageBody>(
        app,
        `/v1/timelines/live:demo/events?from=${iso(offset)}`,
      );
      expect(status, `+${offset}`).toBe(200);
      expect(seqs(body.events), `+${offset}`).toEqual(first === null ? [] : range(first, 8));
      expect(body.nextCursor).toBeNull();
    }
  });

  it("events to a timestamp end at the last sequence received at or before it", async () => {
    const want: Array<[number, number]> = [
      [-1, 0],
      [0, 1],
      [999, 1],
      [1000, 3],
      [2000, 6],
      [3999, 6],
      [4000, 8],
      [99_999, 8],
    ];
    for (const [offset, last] of want) {
      const { status, body } = await getJson<PageBody>(
        app,
        `/v1/timelines/live:demo/events?to=${iso(offset)}`,
      );
      expect(status, `+${offset}`).toBe(200);
      expect(seqs(body.events), `+${offset}`).toEqual(range(1, last));
    }
  });

  it("a window of two timestamps keeps events in between whose own time falls outside it", async () => {
    const window = async (from: number, to: number) => {
      const { body } = await getJson<PageBody>(
        app,
        `/v1/timelines/live:demo/events?from=${iso(from)}&to=${iso(to)}`,
      );
      return seqs(body.events);
    };
    // From the first received at or after +2000 (4, at +3000) to the last at or before +2000 (6).
    expect(await window(2000, 2000)).toEqual([4, 5, 6]);
    // The tie at +1000 is both ends.
    expect(await window(1000, 1000)).toEqual([2, 3]);
    // From +3001 (seq 7) to +4000 (seq 8).
    expect(await window(3001, 4000)).toEqual([7, 8]);
    // From after every event: empty.
    expect(await window(6000, 9000)).toEqual([]);
  });
});
