// M9.06: the `breaks` scenario. Most agents end their turns and stay waiting for minutes, one
// later gets work back, and another later needs the user, so a viewer sees breaks start, a chat,
// and breaks end. Assumed API: `scenario: "breaks"` (default `"default"`) on DemoOptions and
// OfflineOptions.

import { type ProjectState, replay } from "@taskville/domain/reducer";
import { attention } from "@taskville/domain/selectors";
import type { StoredEnvelope } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { CALM, DEMO_EPOCH_MS, generateDemo, runOffline, toStoredEvents } from "../src/index.ts";

const MIN = 60_000;
const SAMPLE_MS = 15_000;
const DURATION_MS = 40 * MIN;
const SEEDS = [1, 7, 42];

const breaksEvents = (seed: number): StoredEnvelope[] =>
  toStoredEvents(
    generateDemo({ seed, pace: CALM, durationMs: DURATION_MS, scenario: "breaks" }).flatMap(
      (s) => s.events,
    ),
    "demo",
  );

const at = (event: StoredEnvelope): number => Date.parse(event.occurredAt);

/** Agents with a waiting attention record and no needs-you record at `now`. */
function waitingAt(state: ProjectState, now: number): Set<string> {
  const records = attention(state, now);
  const needsYou = new Set(records.filter((r) => r.level === "needs_you").map((r) => r.agentId));
  return new Set(
    records.filter((r) => r.level === "waiting" && !needsYou.has(r.agentId)).map((r) => r.agentId),
  );
}

/** The first stretch longer than three minutes where the same four or more agents all wait. */
function longBreak(events: StoredEnvelope[]): { agents: Set<string>; from: number; to: number } {
  let run: { agents: Set<string>; from: number; to: number } | undefined;
  for (let now = DEMO_EPOCH_MS; now <= DEMO_EPOCH_MS + DURATION_MS; now += SAMPLE_MS) {
    const state = replay(
      "demo",
      events.filter((e) => at(e) <= now),
    );
    const waiting = waitingAt(state, now);
    const kept =
      run === undefined ? waiting : new Set([...run.agents].filter((id) => waiting.has(id)));
    if (run !== undefined && kept.size >= 4) run = { agents: kept, from: run.from, to: now };
    else run = waiting.size >= 4 ? { agents: waiting, from: now, to: now } : undefined;
    if (run !== undefined && run.to - run.from > 3 * MIN) return run;
  }
  throw new Error("no stretch over three minutes with four agents waiting");
}

describe("breaks scenario (M9.06)", () => {
  it("is deterministic: the same seed gives the same event stream", () => {
    const a = generateDemo({ seed: 42, pace: CALM, durationMs: 20 * MIN, scenario: "breaks" });
    const b = generateDemo({ seed: 42, pace: CALM, durationMs: 20 * MIN, scenario: "breaks" });
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const x = runOffline({ seed: 42, pace: CALM, durationMs: 20 * MIN, scenario: "breaks" });
    const y = runOffline({ seed: 42, pace: CALM, durationMs: 20 * MIN, scenario: "breaks" });
    expect(x.stateHash).toBe(y.stateHash);
  });

  it("is a different stream from the default scenario, which stays the default", () => {
    const base = runOffline({ seed: 42, pace: CALM, durationMs: 20 * MIN });
    const explicit = runOffline({
      seed: 42,
      pace: CALM,
      durationMs: 20 * MIN,
      scenario: "default",
    });
    const breaks = runOffline({ seed: 42, pace: CALM, durationMs: 20 * MIN, scenario: "breaks" });
    expect(explicit.stateHash).toBe(base.stateHash);
    expect(breaks.stateHash).not.toBe(base.stateHash);
  });

  it("throws for an unknown scenario name", () => {
    expect(() =>
      generateDemo({
        seed: 1,
        pace: CALM,
        durationMs: MIN,
        scenario: "siesta" as unknown as "breaks",
      }),
    ).toThrow(/scenario/i);
  });

  it.each(SEEDS)(
    "seed %i: four or more agents wait, with no needs-you, for over three minutes",
    (seed) => {
      const found = longBreak(breaksEvents(seed));
      expect(found.agents.size).toBeGreaterThanOrEqual(4);
      expect(found.to - found.from).toBeGreaterThan(3 * MIN);
    },
  );

  it.each(SEEDS)("seed %i: one waiting agent then gets work back and another needs you", (seed) => {
    const events = breaksEvents(seed);
    const { agents, from } = longBreak(events);
    const resumed = events.find(
      (e) =>
        at(e) > from &&
        e.agentId !== undefined &&
        agents.has(e.agentId) &&
        (e.type === "session.prompt_submitted" || e.type === "tool_call.started"),
    );
    expect(resumed, "a waiting agent resumes work").toBeDefined();
    const needsYou = events.find(
      (e) =>
        at(e) > at(resumed as StoredEnvelope) &&
        e.type === "request.opened" &&
        e.agentId !== undefined &&
        e.agentId !== resumed?.agentId,
    );
    expect(needsYou, "another agent raises a needs-you after the resume").toBeDefined();
    const now = at(needsYou as StoredEnvelope);
    const state = replay(
      "demo",
      events.filter((e) => at(e) <= now),
    );
    expect(
      attention(state, now).some((r) => r.level === "needs_you" && r.agentId === needsYou?.agentId),
    ).toBe(true);
  });

  it("emits only valid demo-provenance events", () => {
    for (const event of breaksEvents(42)) expect(event.provenance).toBe("demo");
  });
});
