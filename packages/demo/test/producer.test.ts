import type { EventBatchRequest, EventBatchResponse, IngestResult } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { CALM, DemoIngestError, generateDemo, runProducer } from "../src/index.ts";

const MIN = 60_000;

/** A stub ingest route: accepts every event, or applies `verdict` to each one. */
function stubIngest(verdict?: (sourceEventId: string) => IngestResult) {
  const batches: EventBatchRequest[] = [];
  let sequence = 0;
  const post = async (batch: EventBatchRequest): Promise<EventBatchResponse> => {
    batches.push(batch);
    const results = (batch.events as { sourceEventId: string }[]).map(
      (e): IngestResult =>
        verdict?.(e.sourceEventId) ?? {
          sourceEventId: e.sourceEventId,
          status: "accepted",
          ingestSequence: ++sequence,
          eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        },
    );
    return { results, heads: { demo: sequence } };
  };
  return { batches, post };
}

/** A fake wall clock: sleeping advances it, and so does each post by `postMs`. */
const fakeClock = (postMs = 0) => {
  let time = 1_000_000;
  const delays: number[] = [];
  return {
    delays,
    now: () => time,
    sleep: async (ms: number) => {
      delays.push(ms);
      time += ms;
    },
    spend: () => {
      time += postMs;
    },
  };
};
const recordSleep = () => fakeClock();

describe("runProducer", () => {
  it("posts one batch per visible change, exactly the generated events", async () => {
    const ingest = stubIngest();
    const { sleep } = recordSleep();
    const startAtMs = Date.UTC(2026, 9, 31, 12);
    const summary = await runProducer({
      seed: 42,
      pace: CALM,
      projectId: "demo",
      startAtMs,
      durationMs: 10 * MIN,
      post: ingest.post,
      sleep,
      now: () => 0,
    });
    const steps = generateDemo({ seed: 42, pace: CALM, durationMs: 10 * MIN, startAtMs });
    expect(ingest.batches.map((b) => b.events)).toEqual(steps.map((s) => s.events));
    expect(summary).toMatchObject({
      steps: steps.length,
      events: steps.reduce((n, s) => n + s.events.length, 0),
      accepted: steps.reduce((n, s) => n + s.events.length, 0),
      duplicate: 0,
    });
  });

  it("waits the simulated gap divided by the speed before each step", async () => {
    const run = async (speed: number) => {
      const { delays, sleep, now } = recordSleep();
      await runProducer({
        seed: 1,
        pace: CALM,
        projectId: "demo",
        durationMs: 5 * MIN,
        speed,
        post: stubIngest().post,
        sleep,
        now,
      });
      return delays;
    };
    const steps = generateDemo({ seed: 1, pace: CALM, durationMs: 5 * MIN });
    const gaps = steps.slice(1).map((s, i) => s.atMs - (steps[i]?.atMs ?? 0));
    expect(await run(1)).toEqual([0, ...gaps]);
    const fast = await run(20);
    expect(fast).toHaveLength(gaps.length + 1);
    for (const [i, gap] of [0, ...gaps].entries()) expect(fast[i]).toBeCloseTo(gap / 20, 6);
  });

  it("schedules against the wall clock, so time spent posting does not slow the pace", async () => {
    const clock = fakeClock(400);
    const ingest = stubIngest();
    await runProducer({
      seed: 1,
      pace: CALM,
      projectId: "demo",
      durationMs: 5 * MIN,
      post: async (batch) => {
        clock.spend();
        return ingest.post(batch);
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    const steps = generateDemo({ seed: 1, pace: CALM, durationMs: 5 * MIN });
    const gaps = steps.slice(1).map((s, i) => s.atMs - (steps[i]?.atMs ?? 0));
    expect(clock.delays).toEqual([0, ...gaps.map((g) => g - 400)]);
  });

  it("does not post after a stop requested while it slept", async () => {
    const ingest = stubIngest();
    let stopped = false;
    await runProducer({
      seed: 1,
      pace: CALM,
      projectId: "demo",
      post: ingest.post,
      sleep: async () => {
        if (ingest.batches.length === 2) stopped = true;
      },
      now: () => 0,
      stop: () => stopped,
    });
    expect(ingest.batches).toHaveLength(2);
  });

  it("stops when asked, between steps", async () => {
    const ingest = stubIngest();
    await runProducer({
      seed: 1,
      pace: CALM,
      projectId: "demo",
      post: ingest.post,
      sleep: async () => {},
      now: () => 0,
      stop: () => ingest.batches.length >= 3,
    });
    expect(ingest.batches).toHaveLength(3);
  });

  it("counts duplicates, so re-running the same seed and start time is idempotent", async () => {
    const summary = await runProducer({
      seed: 1,
      pace: CALM,
      projectId: "demo",
      durationMs: 2 * MIN,
      post: stubIngest((id) => ({
        sourceEventId: id,
        status: "duplicate",
        ingestSequence: 1,
        eventId: "00000000-0000-4000-8000-000000000001",
      })).post,
      sleep: async () => {},
      now: () => 0,
    });
    expect(summary.accepted).toBe(0);
    expect(summary.duplicate).toBe(summary.events);
  });

  it("fails with the rejection codes when the engine rejects demo events", async () => {
    const reject = stubIngest((id) => ({
      sourceEventId: id,
      status: "rejected",
      error: { code: "unknown_project", path: "projectId", message: "never added" },
    }));
    const error = await runProducer({
      seed: 1,
      pace: CALM,
      projectId: "ghost",
      durationMs: 2 * MIN,
      post: reject.post,
      sleep: async () => {},
      now: () => 0,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DemoIngestError);
    expect((error as DemoIngestError).codes).toEqual(["unknown_project"]);
    expect(reject.batches).toHaveLength(1);
  });

  it("stamps events from the injected start time and project", async () => {
    const ingest = stubIngest();
    await runProducer({
      seed: 3,
      pace: CALM,
      projectId: "city",
      startAtMs: Date.UTC(2030, 0, 1),
      durationMs: MIN,
      post: ingest.post,
      sleep: async () => {},
      now: () => 0,
    });
    const first = ingest.batches[0]?.events[0] as { occurredAt: string; projectId: string };
    expect(first.occurredAt).toBe("2030-01-01T00:00:00.000Z");
    expect(first.projectId).toBe("city");
  });
});
