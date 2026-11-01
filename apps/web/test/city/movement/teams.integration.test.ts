import { describe, expect, it } from "vitest";
import { storedEnvelopeSchemas } from "../../../../../packages/protocol/src/index.ts";
import type { Placement } from "../../../src/city/agents/types.ts";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import { DEFAULT_ACTIVITY_AREAS } from "../../../src/city/movement/areas.ts";
import { buildModels } from "../../../src/city/movement/models.ts";
import { createNavigator } from "../../../src/city/movement/navigator.ts";
import { type ProjectState, reduce } from "../../../src/data/domain.ts";
import { TASK, TEAM, teamScenario } from "../crew/teams/integration.fixture.ts";

function models(state: ProjectState) {
  const input = { ...state, agents: Object.values(state.agents), attention: [] };
  return buildModels(
    input,
    DEFAULT_ACTIVITY_AREAS,
    (): Placement => ({ x: 0, y: 0, z: 0, heading: 0 }),
  );
}

describe("team movement integration", () => {
  it("keeps the lead at Dispatch even when its recorded activity names another area", () => {
    const { state } = teamScenario();
    const input = {
      ...state,
      activity: {
        ...state.activity,
        lead: {
          agentId: "lead",
          activity: "researching" as const,
          heuristic: false,
          since: "2026-11-01T12:00:00.000Z",
          openSessionCount: 0,
        },
      },
    };
    expect(models(input).intents.find((i) => i.id === "lead")?.area).toBe("dispatch");
    expect(models(input).views.find((v) => v.id === "lead")?.activity).toBe("researching");
  });

  it("releases Dispatch after team.ended while the lead continues recorded research", () => {
    const scenario = teamScenario();
    const active = reduce(scenario.state, scenario.leadWork());
    expect(active.teams[TEAM]?.endedAt).toBeUndefined();
    expect(models(active).intents.find((i) => i.id === "lead")?.area).toBe("dispatch");
    expect(models(active).views.find((v) => v.id === "lead")?.activity).toBe("researching");

    const ended = reduce(active, scenario.endTeam());
    const later = scenario.leadWork("2026-11-01T12:01:00.000Z");
    const after = reduce(ended, later);
    expect(after.teams[TEAM]?.endedAt).toBeDefined();
    expect(after.agents.lead?.finishedAt).toBeUndefined();
    expect(after.activity.lead).toMatchObject({ activity: "researching", heuristic: false });
    expect(models(after).views.find((v) => v.id === "lead")?.activity).toBe("researching");
    expect(models(after).intents.find((i) => i.id === "lead")?.area).toBe("archives");
  });

  it.each([
    ["implementing", "workshop"],
    ["testing", "test_lab"],
  ] as const)("routes assignment-free recorded %s to %s", (activity, area) => {
    const scenario = teamScenario();
    const working = reduce(scenario.state, scenario.work(activity));
    expect(Object.values(working.tasks).every((task) => task.assignedAgentIds.length === 0)).toBe(
      true,
    );
    expect(working.activity.pip).toMatchObject({ activity, heuristic: false });
    const result = models(working);
    expect(result.views.find((v) => v.id === "pip")?.activity).toBe(activity);
    expect(result.intents.find((i) => i.id === "pip")?.area).toBe(area);
  });

  it("starts an assigned teammate with no recorded work activity at Dispatch", () => {
    const scenario = teamScenario();
    const assigned = reduce(scenario.state, scenario.claim());
    expect(assigned.tasks[TASK]).toMatchObject({
      status: "assigned",
      assignedAgentIds: ["pip"],
    });
    expect(assigned.activity.pip).toMatchObject({ activity: "idle", heuristic: false });
    const result = models(assigned);
    // Assignment alone supplies no work destination or activity. Dispatch is initial placement.
    expect(result.intents.find((i) => i.id === "pip")?.area).toBeNull();
    expect(result.views.find((v) => v.id === "pip")?.activity).toBe("idle");
    const nav = createNavigator();
    nav.sync(result.intents, { place: true });
    const destination = CITY_LAYOUT.slots.find((s) => s.id === nav.get("pip")?.slotId);
    expect(destination?.areaId).toBe("dispatch");
    expect(nav.get("pip")).toMatchObject({
      state: "idle",
      onTheWay: false,
      x: destination?.x,
      z: destination?.z,
    });
  });

  it("starts an unclaimed teammate at Dispatch and walks to its recorded work area on claim", () => {
    const scenario = teamScenario();
    const nav = createNavigator();
    nav.sync(models(scenario.state).intents, { place: true });
    const before = { ...nav.get("pip") };
    const dispatch = CITY_LAYOUT.slots.filter((s) => s.areaId === "dispatch");
    expect(dispatch.some((s) => s.id === before.slotId)).toBe(true);

    const working = reduce(reduce(scenario.state, scenario.claim()), scenario.work());
    nav.tick(0);
    nav.sync(models(working).intents);
    nav.tick(100);
    expect(nav.get("pip")).toMatchObject({ state: "walking", onTheWay: true });
    for (let t = 200; t <= 120_000; t += 100) nav.tick(t);
    const destination = CITY_LAYOUT.slots.find((s) => s.id === nav.get("pip")?.slotId);
    expect(destination?.areaId).toBe("test_lab");
    expect(nav.get("pip")).toMatchObject({ onTheWay: false, x: destination?.x, z: destination?.z });
  });

  it("keeps an assignment-free teammate idle at its workstation after recorded work", () => {
    const scenario = teamScenario();
    const nav = createNavigator();
    expect(scenario.state.activity.pip?.activity).toBe("idle");
    expect(Object.values(scenario.state.tasks).every((t) => t.assignedAgentIds.length === 0)).toBe(
      true,
    );
    nav.sync(models(scenario.state).intents, { place: true });
    expect(nav.get("pip")).toMatchObject({ state: "idle", onTheWay: false });
    expect(CITY_LAYOUT.slots.find((s) => s.id === nav.get("pip")?.slotId)?.areaId).toBe("dispatch");

    // Work is recorded without task.assigned. Initial Dispatch placement must not pin it there.
    const working = reduce(scenario.state, scenario.work());
    expect(working.tasks).toEqual(scenario.state.tasks);
    nav.tick(0);
    nav.sync(models(working).intents);
    nav.tick(100);
    expect(nav.get("pip")).toMatchObject({ state: "walking", onTheWay: true });
    for (let t = 200; t <= 120_000; t += 100) nav.tick(t);
    const workstation = CITY_LAYOUT.slots.find((s) => s.id === nav.get("pip")?.slotId);
    expect(workstation?.areaId).toBe("test_lab");
    expect(nav.get("pip")).toMatchObject({
      state: "working",
      onTheWay: false,
      x: workstation?.x,
      z: workstation?.z,
    });
    const resting = { ...nav.get("pip"), state: "idle" };

    // TeammateIdle maps to activity.ended, not task.assigned or agent.finished.
    const idleEvent = storedEnvelopeSchemas["activity.ended"].parse({
      ...scenario.work(),
      type: "activity.ended",
      payload: {},
    });
    const idle = reduce(working, idleEvent);
    expect(idle.activity.pip).toMatchObject({ activity: "idle", heuristic: false });
    expect(idle.tasks).toEqual(scenario.state.tasks);
    expect(idle.agents.pip?.finishedAt).toBeUndefined();
    expect(idle.teams[TEAM]?.endedAt).toBeUndefined();
    expect(models(idle).views.find((v) => v.id === "pip")?.activity).toBe("idle");
    nav.sync(models(idle).intents);
    expect.soft(nav.get("pip")).toEqual(resting);
    nav.tick(240_000);
    nav.sync(models(idle).intents);
    expect.soft(nav.get("pip")).toEqual(resting);
  });
});
