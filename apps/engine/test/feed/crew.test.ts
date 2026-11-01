import type { StoredEnvelope } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import {
  type CrewMember,
  type CrewResponse,
  IN_PROCESS_TEAM,
  isRecordedAs,
  NESTED,
  PARALLEL,
  ROUTE_NOW,
  SPIKE_CWD,
  SPLIT_PANE_TEAM,
  useHarness,
} from "./helpers.ts";

// M5.01: GET /v1/agents/:id/crew. The family of one agent, from recorded links only (constitution
// IV): a subagent is a child only after a registration named its parent, a teammate is a member
// only after a registration named its team; a heuristic guess is never a link.
//
// Pinned response: { agentId, projectId, team?, subagents, teammates }. `subagents` are the
// agent's direct children, each with `children` (their own subagents, recursively). `teammates`
// are the members of the team the agent leads, in order of first registration (empty for anyone
// else). A member is { agentId, kind, displayName, agentType, parentAgentId?, status, currentActivity?,
// startedAt, finishedAt?, elapsedMs, resultSummary?, heuristic, children }:
// - status is "running" until the agent finished (SubagentStop) or its team ended, then "finished".
// - elapsedMs is finishedAt (or the engine clock when running) minus startedAt, recorded times only.
// - resultSummary is the summary the finish recorded, when there was one.

const start = useHarness();

async function crewOf(
  h: Awaited<ReturnType<ReturnType<typeof useHarness>>>,
  agentId: string,
): Promise<CrewResponse> {
  const res = await h.crew(agentId);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  return (await res.json()) as CrewResponse;
}

const ids = (members: CrewMember[]) => members.map((m) => m.agentId);
const elapsed = (m: CrewMember, now: Date) =>
  Date.parse(m.finishedAt ?? now.toISOString()) - Date.parse(m.startedAt);

describe("GET /v1/agents/:id/crew: parallel subagents", () => {
  it("lists both running subagents of the lead, linked to it, with activity and elapsed time", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    // Everything before the first SubagentStop: both subagents have started and are working.
    const next = await h.play(PARALLEL.file, {
      stopBefore: (hook) => hook.hook_event_name === "SubagentStop",
    });
    expect(next).toBeGreaterThan(0);

    const crew = await crewOf(h, PARALLEL.lead);
    expect(crew.agentId).toBe(PARALLEL.lead);
    expect(crew.projectId).toBe("spike");
    expect(crew.teammates).toEqual([]);
    expect(ids(crew.subagents)).toEqual([PARALLEL.a, PARALLEL.b]);
    for (const member of crew.subagents) {
      expect(member.kind).toBe("subagent");
      expect(member.parentAgentId).toBe(PARALLEL.lead);
      expect(member.agentType).toBe("general-purpose");
      expect(member.displayName).toBe("general-purpose");
      expect(member.status).toBe("running");
      expect(member.heuristic).toBe(false);
      expect(member.children).toEqual([]);
      expect(member).not.toHaveProperty("finishedAt");
      expect(member).not.toHaveProperty("resultSummary");
      expect(member.currentActivity).toEqual({
        activity: "implementing",
        since: expect.any(String),
        heuristic: false,
      });
      expect(member.elapsedMs).toBeGreaterThan(0);
      expect(member.elapsedMs).toBe(elapsed(member, ROUTE_NOW));
    }
  });

  it("keeps finished subagents, with the result they reported and the time they took", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await h.play(PARALLEL.file);

    const crew = await crewOf(h, PARALLEL.lead);
    expect(ids(crew.subagents)).toEqual([PARALLEL.a, PARALLEL.b]);
    const [a, b] = crew.subagents;
    for (const member of crew.subagents) {
      expect(member.status).toBe("finished");
      expect(member.finishedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(member.elapsedMs).toBe(elapsed(member, ROUTE_NOW));
      expect(Date.parse(member.finishedAt ?? "")).toBeGreaterThanOrEqual(
        Date.parse(member.startedAt),
      );
    }
    expect(a?.resultSummary).toContain("The line count is **3**.");
    expect(b?.resultSummary).toContain("hello from B");
  });

  it("gives a subagent an empty crew of its own", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await h.play(PARALLEL.file);
    const crew = await crewOf(h, PARALLEL.a);
    expect(crew.agentId).toBe(PARALLEL.a);
    expect(crew.subagents).toEqual([]);
    expect(crew.teammates).toEqual([]);
  });
});

describe("GET /v1/agents/:id/crew: nested subagents", () => {
  it("nests the inner subagent under the outer one, and gives each level its own crew", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await h.play(NESTED.file);

    const lead = await crewOf(h, NESTED.lead);
    expect(ids(lead.subagents)).toEqual([NESTED.outer]);
    const outer = lead.subagents[0];
    expect(outer?.agentType).toBe("outer");
    expect(outer?.parentAgentId).toBe(NESTED.lead);
    expect(ids(outer?.children ?? [])).toEqual([NESTED.inner]);
    const inner = outer?.children[0];
    expect(inner?.parentAgentId).toBe(NESTED.outer);
    expect(inner?.agentType).toBe("inner");
    expect(inner?.status).toBe("finished");
    expect(inner?.resultSummary).toContain("nested-ok");
    expect(inner?.children).toEqual([]);

    const outerCrew = await crewOf(h, NESTED.outer);
    expect(ids(outerCrew.subagents)).toEqual([NESTED.inner]);
    expect((await crewOf(h, NESTED.inner)).subagents).toEqual([]);
  });

  it("does not link the inner subagent to a parent before the recording names one", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    // The synchronous inner call finished (SubagentStop) but the parent's PostToolUse(Agent), the
    // only record of the link, has not arrived: S-2 says leave the parent unknown.
    await h.play(NESTED.file, { stopAfter: isRecordedAs("agent.finished", NESTED.inner) });

    const lead = await crewOf(h, NESTED.lead);
    expect(ids(lead.subagents)).toEqual([NESTED.outer]);
    expect(lead.subagents[0]?.children).toEqual([]);
    expect((await crewOf(h, NESTED.outer)).subagents).toEqual([]);
  });
});

describe("GET /v1/agents/:id/crew: agent teams", () => {
  it("lists the teammates of an in-process team on the lead, in order of registration", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await h.play(IN_PROCESS_TEAM.file);

    const crew = await crewOf(h, IN_PROCESS_TEAM.lead);
    expect(crew.subagents).toEqual([]);
    expect(crew.team).toMatchObject({
      name: "session-cf46f41b",
      leadAgentId: IN_PROCESS_TEAM.lead,
      startedAt: expect.any(String),
    });
    expect(crew.team).not.toHaveProperty("endedAt");
    expect(ids(crew.teammates)).toEqual([IN_PROCESS_TEAM.pip, IN_PROCESS_TEAM.bo]);
    const [pip, bo] = crew.teammates;
    expect([pip?.displayName, bo?.displayName]).toEqual(["pip", "bo"]);
    for (const member of crew.teammates) {
      expect(member.kind).toBe("teammate");
      expect(member.status).toBe("running");
      expect(member.heuristic).toBe(false);
      expect(member).not.toHaveProperty("parentAgentId");
      expect(member.elapsedMs).toBe(elapsed(member, ROUTE_NOW));
    }
  });

  it("shows a teammate its team but no teammates of its own", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await h.play(IN_PROCESS_TEAM.file);
    const crew = await crewOf(h, IN_PROCESS_TEAM.pip);
    expect(crew.teammates).toEqual([]);
    expect(crew.subagents).toEqual([]);
    expect(crew.team?.leadAgentId).toBe(IN_PROCESS_TEAM.lead);
  });

  it("lists split-pane teammates (their own sessions) once their registration names the team", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await h.play(SPLIT_PANE_TEAM.file);
    const crew = await crewOf(h, SPLIT_PANE_TEAM.lead);
    expect(ids(crew.teammates)).toEqual([SPLIT_PANE_TEAM.pip, SPLIT_PANE_TEAM.bo]);
    for (const member of crew.teammates) expect(member.heuristic).toBe(false);
  });

  it("never links a teammate on a heuristic guess", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    // Stop right after pip is first named by a heuristic registration (its first SendMessage),
    // before the TeammateIdle that records its team membership.
    const guessed = (events: StoredEnvelope[]) =>
      events.some(
        (e) =>
          e.type === "agent.registered" &&
          e.agentId === SPLIT_PANE_TEAM.pip &&
          (e.payload as { heuristic?: boolean }).heuristic === true,
      );
    await h.play(SPLIT_PANE_TEAM.file, { stopAfter: guessed });
    const crew = await crewOf(h, SPLIT_PANE_TEAM.lead);
    expect(ids(crew.teammates)).not.toContain(SPLIT_PANE_TEAM.pip);
    for (const member of [...crew.teammates, ...crew.subagents])
      expect(member.heuristic).toBe(false);
  });
});

describe("GET /v1/agents/:id/crew: errors", () => {
  it("answers 404 unknown_agent for an agent with no recorded events", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await h.play(PARALLEL.file);
    for (const agent of ["claude-code:no-such-session", "a".repeat(500)]) {
      const res = await h.crew(agent);
      expect(res.status, agent.slice(0, 20)).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "unknown_agent", message: expect.any(String) },
      });
    }
  });
});
