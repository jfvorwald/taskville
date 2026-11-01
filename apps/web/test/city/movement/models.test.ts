import { describe, expect, it } from "vitest";
import type { AgentLabelEntry, Placement } from "../../../src/city/agents/index.ts";
import { DEFAULT_ACTIVITY_AREAS } from "../../../src/city/movement/areas.ts";
import { createLabelStore, labelRows } from "../../../src/city/movement/labels.ts";
import {
  type AgentActivity,
  agentCounts,
  buildModels,
  type ModelInput,
} from "../../../src/city/movement/models.ts";
import { type Agent, type Attention, attention } from "../../../src/data/domain.ts";

const T = "2026-10-31T10:00:00.000Z";

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    sourceId: "demo:7",
    sourceAgentId: id,
    displayName: id.toUpperCase(),
    kind: "session",
    registered: true,
    connection: "connected",
    firstSeenAt: T,
    lastSeenAt: T,
    toolCallCount: 0,
    consecutiveToolFailures: 0,
    ...extra,
  } as Agent;
}

function activity(agentId: string, value: AgentActivity["activity"]): AgentActivity {
  return { agentId, activity: value, heuristic: false, since: T, openSessionCount: 1 };
}

const pool = () => {
  const placements = new Map<string, Placement>();
  return (id: string) => {
    let p = placements.get(id);
    if (!p) {
      p = { x: 0, y: 0, z: 0, heading: 0 };
      placements.set(id, p);
    }
    return p;
  };
};

describe("store to agents and navigation", () => {
  const input: ModelInput = {
    agents: [
      agent("ada", { kind: "lead", teamId: "t1" }),
      agent("dee"),
      agent("sub", { kind: "subagent", parentAgentId: "ada", role: "security-reviewer" }),
      agent("subsub", { kind: "subagent", parentAgentId: "sub", role: "Explore" }),
      agent("gone", { finishedAt: T }),
    ],
    activity: {
      ada: activity("ada", "dispatching"),
      dee: activity("dee", "testing"),
      sub: activity("sub", "reviewing"),
    },
    attention: [
      {
        agentId: "dee",
        level: "needs_you",
        kind: "permission",
        since: T,
        heuristic: false,
      } as Attention,
      { agentId: "dee", level: "waiting", kind: "turn_ended", since: T, heuristic: false },
      { agentId: "ada", level: "trouble", kind: "silent", since: T, heuristic: true },
    ],
  };

  it("maps each live non-subagent to a view with a stable placement, and finished agents leave", () => {
    const placementFor = pool();
    const { views, intents } = buildModels(input, DEFAULT_ACTIVITY_AREAS, placementFor);
    // Subagents are drawn by the crew layer, so they have no block-agent view here (M5.02).
    expect(views.map((v) => v.id)).toEqual(["ada", "dee"]);
    // They keep their navigation intents, so the navigator still knows them.
    expect(intents.map((i) => i.id)).toEqual(["ada", "dee", "sub", "subsub"]);

    const [ada, dee] = views;
    expect(ada).toMatchObject({ kind: "lead", teamId: "t1", activity: "dispatching", depth: 0 });
    expect(ada?.attention).toMatchObject({ level: "trouble", heuristic: true });
    expect(dee).toMatchObject({ displayName: "DEE", activity: "testing" });
    // The most urgent record wins.
    expect(dee?.attention?.level).toBe("needs_you");
    expect(dee?.placement).toBe(placementFor("dee"));

    // A second build reuses the placement objects navigation mutates.
    const again = buildModels(input, DEFAULT_ACTIVITY_AREAS, placementFor);
    expect(again.views[1]?.placement).toBe(dee?.placement);
  });

  it("draws a subagent once: no block-agent view at any depth, intent kept", () => {
    const { views, intents } = buildModels(input, DEFAULT_ACTIVITY_AREAS, pool());
    expect(views.some((v) => v.kind === "subagent")).toBe(false);
    expect(views.map((v) => v.id)).not.toContain("sub");
    expect(views.map((v) => v.id)).not.toContain("subsub");
    expect(intents.find((i) => i.id === "sub")).toEqual({
      id: "sub",
      area: "security",
      hold: false,
      rest: "working",
      parentId: "ada",
    });
    expect(intents.find((i) => i.id === "subsub")).toMatchObject({ parentId: "sub" });
  });

  it("leaves leads, teammates and solo sessions as block-agent views", () => {
    const { views, intents } = buildModels(
      {
        agents: [
          agent("lead1", { kind: "lead", teamId: "t1" }),
          agent("mate", { kind: "teammate", teamId: "t1", parentAgentId: "lead1" }),
          agent("solo"),
          agent("kid", { kind: "subagent", parentAgentId: "solo" }),
        ],
        activity: {},
        attention: [],
      },
      DEFAULT_ACTIVITY_AREAS,
      pool(),
    );
    expect(views.map((v) => [v.id, v.kind])).toEqual([
      ["lead1", "lead"],
      ["mate", "teammate"],
      ["solo", "session"],
    ]);
    expect(intents.map((i) => i.id)).toEqual(["lead1", "mate", "solo", "kid"]);
  });

  it("keeps a subagent's needs-you hold in its intent, though it has no view", () => {
    const { views, intents } = buildModels(
      {
        agents: [agent("solo"), agent("kid", { kind: "subagent", parentAgentId: "solo" })],
        activity: {},
        attention: [
          { agentId: "kid", level: "needs_you", kind: "permission", since: T, heuristic: false },
        ],
      },
      DEFAULT_ACTIVITY_AREAS,
      pool(),
    );
    expect(views.map((v) => v.id)).toEqual(["solo"]);
    expect(intents.find((i) => i.id === "kid")?.hold).toBe(true);
  });

  it("derives destinations, holds and rest states from the recorded state", () => {
    const { intents } = buildModels(input, DEFAULT_ACTIVITY_AREAS, pool());
    expect(intents).toEqual([
      { id: "ada", area: "dispatch", hold: false, rest: "working" },
      { id: "dee", area: "test_lab", hold: true, rest: "working" },
      { id: "sub", area: "security", hold: false, rest: "working", parentId: "ada" },
      { id: "subsub", area: null, hold: false, rest: "working", parentId: "sub" },
    ]);
    const waiting = buildModels(
      {
        agents: [agent("a"), agent("b")],
        activity: { a: activity("a", "idle"), b: activity("b", "implementing") },
        attention: [
          { agentId: "b", level: "waiting", kind: "turn_ended", since: T, heuristic: false },
        ],
      },
      DEFAULT_ACTIVITY_AREAS,
      pool(),
    );
    expect(waiting.intents.map((i) => i.rest)).toEqual(["idle", "waiting"]);
  });

  it("counts active agents and agents that need you for the header", () => {
    expect(agentCounts(input.agents, { needsYou: 1, trouble: 1, waiting: 1 })).toEqual({
      active: 4,
      needsYou: 1,
    });
  });
});

describe("agent labels", () => {
  const entry = (id: string, status: string): AgentLabelEntry => ({
    id,
    name: id,
    status,
    anchor: { x: 0, y: 0, z: 0, heading: 0 },
    offsetY: 1.25,
  });

  it("shows the recorded status at once while the agent is still walking, with an on-the-way mark", () => {
    const rows = labelRows(
      [entry("dee", "Testing"), entry("ada", "Needs you")],
      (id) =>
        id === "dee" ? { state: "walking", onTheWay: true } : { state: "stuck", onTheWay: false },
      new Set(["ada"]),
    );
    expect(rows).toEqual([
      {
        id: "dee",
        name: "dee",
        status: "Testing",
        onTheWay: true,
        state: "walking",
        urgent: false,
      },
      {
        id: "ada",
        name: "ada",
        status: "Needs you",
        onTheWay: false,
        state: "stuck",
        urgent: true,
      },
    ]);
  });

  it("keeps its snapshot reference until the rows change", () => {
    const store = createLabelStore();
    let calls = 0;
    store.subscribe(() => calls++);
    const rows = labelRows([entry("a", "Testing")], () => ({ state: "working", onTheWay: false }));
    store.set(rows);
    const first = store.getSnapshot();
    store.set(labelRows([entry("a", "Testing")], () => ({ state: "working", onTheWay: false })));
    expect(store.getSnapshot()).toBe(first);
    expect(calls).toBe(1);
    store.set(labelRows([entry("a", "Testing")], () => ({ state: "walking", onTheWay: true })));
    expect(store.getSnapshot()).not.toBe(first);
    expect(calls).toBe(2);
  });
});

describe("attention wiring into the agent view", () => {
  const MIN = 60_000;
  const SEEN = "2026-05-01T10:00:00.000Z";
  const SEEN_MS = Date.parse(SEEN);

  /** A real silent-trouble record: `since` is `lastSeenAt`, `reason.text` comes from the selector. */
  function silentRecord(now: number): Attention {
    const quiet = {
      id: "a1",
      connection: "connected" as const,
      lastSeenAt: SEEN,
      consecutiveToolFailures: 0,
    };
    const found = attention({ agents: { a1: quiet }, requests: {} }, now);
    const first = found[0];
    if (first === undefined) throw new Error("no attention record");
    return first;
  }

  const build = (record: Attention) =>
    buildModels(
      { agents: [agent("a1")], activity: { a1: activity("a1", "idle") }, attention: [record] },
      DEFAULT_ACTIVITY_AREAS,
      pool(),
    ).views[0]?.attention;

  it("carries the parsed since, the kind and the selector's quiet text onto the view", () => {
    const view = build(silentRecord(SEEN_MS + 12 * MIN));
    expect(view?.sinceMs).toBe(Date.parse(SEEN));
    expect(view?.kind).toBe("silent");
    expect(view?.level).toBe("trouble");
    expect(view?.detail).toBe("quiet for 12 min");
  });

  it("leaves sinceMs off the view when since does not parse", () => {
    const view = build({ ...silentRecord(SEEN_MS + 12 * MIN), since: "not a date" });
    expect(view).toBeDefined();
    expect(view).not.toHaveProperty("sinceMs");
  });
});
