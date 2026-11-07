import { createHash } from "node:crypto";
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

const breaksEventsFor = breaksEvents;

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
function longBreak(
  events: StoredEnvelope[],
  only: (agentId: string) => boolean = () => true,
): { agents: Set<string>; from: number; to: number } {
  let run: { agents: Set<string>; from: number; to: number } | undefined;
  for (let now = DEMO_EPOCH_MS; now <= DEMO_EPOCH_MS + DURATION_MS; now += SAMPLE_MS) {
    const state = replay(
      "demo",
      events.filter((e) => at(e) <= now),
    );
    const waiting = new Set([...waitingAt(state, now)].filter(only));
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

describe("breaks scenario source event keys (roborev 7278)", () => {
  const keyOf = (e: { projectId: string; sourceId: string; sourceEventId: string }): string =>
    `${e.projectId}\u0000${e.sourceId}\u0000${e.sourceEventId}`;
  const keysFor = (scenario: "default" | "breaks", startAtMs?: number): Set<string> =>
    new Set(
      generateDemo({
        seed: 7,
        pace: CALM,
        durationMs: 20 * MIN,
        scenario,
        ...(startAtMs === undefined ? {} : { startAtMs }),
      })
        .flatMap((s) => s.events)
        .map(keyOf),
    );

  it("never reuses a default-scenario key for the same seed and start time (default epoch)", () => {
    const defaults = keysFor("default");
    const shared = [...keysFor("breaks")].filter((k) => defaults.has(k));
    expect(shared).toEqual([]);
  });

  it("never reuses a default-scenario key for the same seed and an explicit start time", () => {
    const start = DEMO_EPOCH_MS + 12_345;
    const defaults = keysFor("default", start);
    const shared = [...keysFor("breaks", start)].filter((k) => defaults.has(k));
    expect(shared).toEqual([]);
  });

  it("still repeats the same keys when the same breaks run is generated twice", () => {
    expect([...keysFor("breaks")]).toEqual([...keysFor("breaks")]);
  });

  it("keeps the default stream for seed 7 byte-identical (pinned from the pre-fix code)", () => {
    const events = generateDemo({ seed: 7, pace: CALM, durationMs: 20 * MIN }).flatMap(
      (s) => s.events,
    );
    expect(events).toHaveLength(160);
    expect(createHash("sha256").update(JSON.stringify(events)).digest("hex")).toBe(
      "9847d802e97de2271ac6a4ba65bf11aa9b7b787ef0e36e6ff2f3bb7ba493f8dc",
    );
    expect(runOffline({ seed: 7, pace: CALM, durationMs: 20 * MIN }).stateHash).toBe(
      "9:f47208a1d1d0f6fa40be8e601ad530d60ef6eb90d15d444dd01fdc9194b12cfa",
    );
  });
});

describe("breaks scenario entity IDs never collide with the default (roborev 7297)", () => {
  const SEED = 7;
  const defaultEvents = (): StoredEnvelope[] =>
    toStoredEvents(
      generateDemo({ seed: SEED, pace: CALM, durationMs: DURATION_MS }).flatMap((s) => s.events),
      "demo",
    );

  /** Every entity identifier an event carries, by kind: envelope fields and payload references. */
  function idsByKind(events: StoredEnvelope[]): Record<string, Set<string>> {
    const kinds: Record<string, Set<string>> = {
      agent: new Set(),
      session: new Set(),
      task: new Set(),
      team: new Set(),
      toolCall: new Set(),
      request: new Set(),
    };
    const add = (kind: string, value: unknown): void => {
      if (typeof value === "string") kinds[kind]?.add(value);
    };
    for (const e of events) {
      const p = e.payload as Record<string, unknown>;
      add("agent", e.agentId);
      add("session", e.sessionId);
      add("task", e.taskId);
      for (const key of ["parentAgentId", "leadAgentId", "fromAgentId", "toAgentId"])
        add("agent", p[key]);
      if (Array.isArray(p.agentIds)) for (const id of p.agentIds) add("agent", id);
      add("team", p.teamId);
      add("toolCall", p.toolCallId);
      add("request", p.requestId);
    }
    return kinds;
  }

  it.each(["agent", "session", "task", "team", "toolCall", "request"])(
    "the breaks stream shares no %s ID with the default stream (same seed and project)",
    (kind) => {
      const base = idsByKind(defaultEvents())[kind] as Set<string>;
      const breaks = idsByKind(breaksEventsFor(SEED))[kind] as Set<string>;
      expect(base.size, `default emits ${kind} IDs`).toBeGreaterThan(0);
      // The breaks scenario has no tasks or teams today; disjointness still guards them.
      if (kind !== "task" && kind !== "team")
        expect(breaks.size, `breaks emits ${kind} IDs`).toBeGreaterThan(0);
      expect([...breaks].filter((id) => base.has(id))).toEqual([]);
    },
  );

  it("replaying both streams into one project keeps two distinct sets of agents, each with its own source", () => {
    const base = defaultEvents();
    const breaks = breaksEventsFor(SEED);
    const raw = (scenario?: "breaks") =>
      generateDemo({
        seed: SEED,
        pace: CALM,
        durationMs: DURATION_MS,
        ...(scenario === undefined ? {} : { scenario }),
      }).flatMap((step) => step.events);
    const both = toStoredEvents([...raw(), ...raw("breaks")], "demo");
    const state = replay("demo", both);
    const agents = Object.values(state.agents);
    const baseAgents = agents.filter((a) => a.sourceId === `demo:${SEED}`);
    const breaksAgents = agents.filter((a) => a.sourceId === `demo:breaks:${SEED}`);
    const baseIds = idsByKind(base).agent as Set<string>;
    const breaksIds = idsByKind(breaks).agent as Set<string>;
    expect(baseAgents.map((a) => a.id).sort()).toEqual([...baseIds].sort());
    expect(breaksAgents.map((a) => a.id).sort()).toEqual([...breaksIds].sort());
    expect(agents).toHaveLength(baseAgents.length + breaksAgents.length);
    expect(breaksAgents.every((a) => a.registered)).toBe(true);
    expect(breaksAgents.length).toBeGreaterThanOrEqual(6);

    // The breaks agents still reach the long-wait window inside the combined project.
    const found = longBreak(both, (id) => breaksIds.has(id));
    expect(found.agents.size).toBeGreaterThanOrEqual(4);
    expect(found.to - found.from).toBeGreaterThan(3 * MIN);
  });
});
