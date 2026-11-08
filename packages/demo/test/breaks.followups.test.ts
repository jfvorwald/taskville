// M9.09: follow-ups to the `breaks` scenario.
//  1. `demo --speed N` must not stamp events ahead of wall time: a record posted at wall time T is
//     stamped at or before T (the replay compresses the gaps instead), so waiting records are
//     never in the future and breaks start on time in the browser.
//  2. The scenario emits an `activity.started` for every agent that gets work back, so the agent
//     has a status and an area to walk to.

import type { EventBatchRequest, EventBatchResponse } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { CALM, generateDemo, runProducer } from "../src/index.ts";

const MIN = 60_000;

describe("breaks scenario at higher speeds (M9.09)", () => {
  it.each([1, 6, 60])(
    "speed %i: no event is stamped after the wall time it is posted at",
    async (speed) => {
      let wall = 5_000_000_000;
      const startAtMs = wall;
      const posted: { wall: number; occurredAt: number }[] = [];
      const post = async (batch: EventBatchRequest): Promise<EventBatchResponse> => {
        for (const e of batch.events as { occurredAt: string }[]) {
          posted.push({ wall, occurredAt: Date.parse(e.occurredAt) });
        }
        const results = (batch.events as { sourceEventId: string }[]).map((e, i) => ({
          sourceEventId: e.sourceEventId,
          status: "accepted" as const,
          ingestSequence: i + 1,
          eventId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        }));
        return { results, heads: { demo: results.length } };
      };
      await runProducer({
        seed: 7,
        pace: CALM,
        projectId: "demo",
        scenario: "breaks",
        speed,
        startAtMs,
        durationMs: 30 * MIN,
        post,
        sleep: async (ms) => {
          wall += ms;
        },
        now: () => wall,
      });
      expect(posted.length).toBeGreaterThan(50);
      const ahead = posted.filter((p) => p.occurredAt > p.wall);
      expect(
        ahead.length,
        `${ahead.length} of ${posted.length} events stamped ahead of wall time (worst by ${Math.max(0, ...posted.map((p) => p.occurredAt - p.wall)) / 1000} s)`,
      ).toBe(0);
      // Still ordered, and never before the start time.
      for (const [i, p] of posted.entries()) {
        expect(p.occurredAt).toBeGreaterThanOrEqual(startAtMs);
        if (i > 0) expect(p.occurredAt).toBeGreaterThanOrEqual(posted[i - 1]?.occurredAt ?? 0);
      }
    },
  );
});

describe("breaks scenario activity events (M9.09)", () => {
  const events = (seed: number) =>
    generateDemo({ seed, pace: CALM, durationMs: 40 * MIN, scenario: "breaks" }).flatMap(
      (s) => s.events,
    ) as unknown as {
      type: string;
      agentId?: string;
      payload: { activity?: string };
    }[];

  it.each([1, 7, 42])(
    "seed %i: every agent that gets a prompt back then starts an activity before its next turn ends",
    (seed) => {
      const all = events(seed);
      const resumes = all
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === "session.prompt_submitted");
      expect(resumes.length, "agents get work back").toBeGreaterThanOrEqual(2);
      for (const { e, i } of resumes) {
        const next = all.findIndex(
          (x, j) => j > i && x.agentId === e.agentId && x.type === "session.turn_ended",
        );
        const window = all.slice(i + 1, next === -1 ? undefined : next);
        const started = window.find(
          (x) => x.agentId === e.agentId && x.type === "activity.started",
        );
        expect(started, `${e.agentId} gets work back without an activity`).toBeDefined();
        expect(typeof started?.payload.activity).toBe("string");
        expect(started?.payload.activity).not.toBe("");
      }
    },
  );

  it("the resumed activity is one with an area in the city (implementing, testing, reviewing, documenting, researching, dispatching)", () => {
    const known = [
      "implementing",
      "testing",
      "reviewing",
      "documenting",
      "researching",
      "dispatching",
    ];
    const all = events(7).filter((e) => e.type === "activity.started");
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) expect(known).toContain(e.payload.activity);
  });
});
