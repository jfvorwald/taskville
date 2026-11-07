import { describe, expect, it } from "vitest";
import type { BreakPlan } from "../../../src/city/breaks/types.ts";
import { breakSpots, type PlanSource, planInputs } from "../../../src/city/breaks/usePlan.ts";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import type { Agent, Attention } from "../../../src/data/domain.ts";

// M9.08: the pure part of the wiring. `planInputs` turns the data store's slices, the layout, the
// clock and the Break time setting into the exact BreakPlanInput; `breakSpots` turns a plan into
// the navigator's `breakSpot` destinations. No React, no clock of its own.
// Run: pnpm exec vitest run --root ../.. --project @taskville/web test/city/breaks/usePlan  (from apps/web)

const T = "2026-10-31T10:00:00.000Z";
const T_MS = Date.parse(T);

const agent = (id: string, extra: Partial<Agent> = {}): Agent =>
  ({
    id,
    sourceId: "demo:1",
    sourceAgentId: id,
    kind: "session",
    registered: true,
    connection: "connected",
    firstSeenAt: T,
    lastSeenAt: T,
    toolCallCount: 0,
    consecutiveToolFailures: 0,
    ...extra,
  }) as Agent;

const record = (
  agentId: string,
  level: Attention["level"],
  kind: string,
  since: string,
  requestId?: string,
): Attention =>
  ({ agentId, level, kind, since, ...(requestId === undefined ? {} : { requestId }) }) as Attention;

const source = (over: Partial<PlanSource> = {}): PlanSource => ({
  now: T_MS + 90_000,
  enabled: true,
  night: false,
  layout: CITY_LAYOUT,
  agents: [],
  activity: {},
  attention: [],
  sessions: {},
  ...over,
});

describe("planInputs", () => {
  it("maps the layout: one site per break site with its spot count, and the plaza node count", () => {
    const input = planInputs(source());
    const plazaNodes = CITY_LAYOUT.graph.nodes.filter((n) => n.kind === "plaza").length;
    expect(plazaNodes).toBeGreaterThan(0);
    expect(input.plazaSpots).toBe(plazaNodes);
    expect(input.sites).toEqual(
      CITY_LAYOUT.breakSites.map((s) => ({ id: s.id, kind: s.id, spots: s.spots.length })),
    );
    expect(input.sites.length).toBe(2);
  });

  it("passes the clock, the setting and night through", () => {
    const night = (ms: number) => ms % 2 === 0;
    const input = planInputs(source({ now: 123_456, enabled: false, night }));
    expect(input.now).toBe(123_456);
    expect(input.enabled).toBe(false);
    expect(input.night).toBe(night);
    expect(planInputs(source({ night: true })).night).toBe(true);
  });

  it("builds a waiting agent from its waiting record: event id, since, rest and level", () => {
    const since = "2026-10-31T10:00:30.000Z";
    const input = planInputs(
      source({
        agents: [agent("a1")],
        attention: [record("a1", "waiting", "turn_ended", since)],
      }),
    );
    expect(input.agents).toEqual([
      {
        id: "a1",
        rest: "waiting",
        level: "waiting",
        waitingEventId: `turn_ended@${since}`,
        waitingSince: Date.parse(since),
        liveSession: false,
      },
    ]);
  });

  it("uses the request id as the event id when the waiting record has one", () => {
    const input = planInputs(
      source({
        agents: [agent("a1")],
        attention: [record("a1", "waiting", "turn_ended", T, "req-9")],
      }),
    );
    expect(input.agents[0]?.waitingEventId).toBe("req-9");
  });

  it("marks needs_you and trouble agents by level and keeps them working at rest", () => {
    const input = planInputs(
      source({
        agents: [agent("n1"), agent("t1")],
        activity: { n1: { activity: "implementing" }, t1: { activity: "testing" } },
        attention: [
          record("n1", "needs_you", "permission", T, "r1"),
          record("t1", "trouble", "tool_failures", T),
        ],
      }),
    );
    expect(input.agents.map((a) => [a.id, a.level, a.rest, a.waitingSince])).toEqual([
      ["n1", "needs_you", "working", null],
      ["t1", "trouble", "working", null],
    ]);
  });

  it("gives an agent with no record level null and no waiting seed", () => {
    const input = planInputs(
      source({ agents: [agent("w1")], activity: { w1: { activity: "implementing" } } }),
    );
    expect(input.agents).toEqual([
      {
        id: "w1",
        rest: "working",
        level: null,
        waitingEventId: null,
        waitingSince: null,
        liveSession: false,
      },
    ]);
  });

  it("reads rest from the activity: idle, and waiting without a record", () => {
    const input = planInputs(
      source({
        agents: [agent("i1"), agent("w2")],
        activity: { i1: { activity: "idle" }, w2: { activity: "waiting" } },
      }),
    );
    expect(input.agents.map((a) => [a.id, a.rest])).toEqual([
      ["i1", "idle"],
      ["w2", "waiting"],
    ]);
  });

  it("flags a live session only when one of the agent's sessions has not ended", () => {
    const input = planInputs(
      source({
        agents: [agent("i1"), agent("i2"), agent("i3")],
        activity: {
          i1: { activity: "idle" },
          i2: { activity: "idle" },
          i3: { activity: "idle" },
        },
        sessions: {
          s1: { agentId: "i1" },
          s2: { agentId: "i2", endedAt: T },
          s3: { agentId: "other" },
        },
      }),
    );
    expect(input.agents.map((a) => [a.id, a.liveSession])).toEqual([
      ["i1", true],
      ["i2", false],
      ["i3", false],
    ]);
  });

  it("skips finished agents", () => {
    const input = planInputs(source({ agents: [agent("a1"), agent("gone", { finishedAt: T })] }));
    expect(input.agents.map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("breakSpots", () => {
  const bar = CITY_LAYOUT.breakSites.find((s) => s.id === "bar");
  const smoke = CITY_LAYOUT.breakSites.find((s) => s.id === "smoke");
  const brk = (siteId: string | null, spot: number) => ({
    activity: "stroll" as const,
    siteId,
    spot,
    startedAt: 0,
    endsAt: 1,
  });

  it("maps a site break to that spot's graph node", () => {
    const plan: BreakPlan = {
      agents: new Map([
        ["a1", { ...brk("bar", 2), activity: "bar" }],
        ["a2", { ...brk("smoke", 0), activity: "smoke" }],
      ]),
      conversations: [],
    };
    const spots = breakSpots(plan, CITY_LAYOUT);
    expect(spots.get("a1")).toEqual({ kind: "site", nodeId: bar?.spots[2]?.nodeId });
    expect(spots.get("a2")).toEqual({ kind: "site", nodeId: smoke?.spots[0]?.nodeId });
  });

  it("maps a plaza break (siteId null) to the plaza index", () => {
    const plan: BreakPlan = { agents: new Map([["a1", brk(null, 3)]]), conversations: [] };
    expect(breakSpots(plan, CITY_LAYOUT).get("a1")).toEqual({ kind: "plaza", index: 3 });
  });

  it("has no entry for an agent that is not on break", () => {
    const plan: BreakPlan = { agents: new Map(), conversations: [] };
    expect(breakSpots(plan, CITY_LAYOUT).size).toBe(0);
  });
});
