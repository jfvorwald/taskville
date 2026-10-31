import { describe, expect, it } from "vitest";
import { parseInputEvent } from "../../../../protocol/src/index.ts";
import type { CrewEvent } from "../../../src/claude-code/crew/index.ts";
import { allEvents, at, readFixture, replay } from "./replay.ts";

// Golden tests on every S-2 subagent and team stream (#23 Done when), plus the behaviors that
// decision #120 and docs/spikes/S-2-crews.md pin down, asserted directly so a golden update
// cannot quietly change them.

const STREAMS = [
  "subagent/nested",
  "subagent/parallel",
  "team/in-process",
  "team/split-pane",
  "team/split-pane-speculative",
] as const;

const of = (events: CrewEvent[], type: string) => events.filter((e) => e.type === type);

describe.each(STREAMS)("%s", (name) => {
  const mapped = replay(name);
  const events = allEvents(mapped);

  it("matches the golden event list", async () => {
    await expect(`${JSON.stringify(mapped, null, 2)}\n`).toMatchFileSnapshot(
      `golden/${name.replace("/", "-")}.json`,
    );
  });

  it("emits only valid protocol v1 input events", () => {
    for (const event of events) {
      const parsed = parseInputEvent(event);
      expect(parsed.ok, JSON.stringify({ event, parsed })).toBe(true);
    }
  });

  it("gives every event a unique, bounded sourceEventId", () => {
    const ids = events.map((e) => e.sourceEventId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(200);
  });

  it("never emits for internal helper agents (agent_id with empty or missing agent_type)", () => {
    const helpers = readFixture(name)
      .map((l) => l.input)
      .filter((i) => typeof i.agent_id === "string" && !i.agent_type)
      .map((i) => String(i.agent_id));
    for (const e of events) {
      for (const helper of helpers) expect(JSON.stringify(e)).not.toContain(helper);
    }
  });
});

describe("subagent/nested", () => {
  const mapped = replay("subagent/nested");
  const session = "cc:6effc000-24c8-436e-ae5e-33152b820f83";
  const outer = `${session}:ac5497782768787b9`;
  const inner = `${session}:a0c1bc9a2c30e80b6`;

  it("creates each subagent on SubagentStart, with no parent yet", () => {
    const [start] = at(mapped, 3).events;
    expect(start).toMatchObject({
      type: "agent.registered",
      agentId: outer,
      payload: { kind: "subagent", sourceAgentId: outer, displayName: "outer" },
    });
    expect(start?.payload).not.toHaveProperty("parentAgentId");
  });

  it("links a subagent to the caller of the Agent call that returned its agentId", () => {
    const outerLink = of(at(mapped, 4).events, "agent.registered")[0];
    expect(outerLink).toMatchObject({ agentId: outer, payload: { parentAgentId: session } });
    // The nested call: outer's own PostToolUse(Agent) names inner, so inner's parent is outer.
    const innerLink = of(at(mapped, 12).events, "agent.registered")[0];
    expect(innerLink).toMatchObject({
      agentId: inner,
      payload: { kind: "subagent", parentAgentId: outer, displayName: "inner" },
    });
  });

  it("finishes each subagent on SubagentStop", () => {
    expect(at(mapped, 11).events).toMatchObject([{ type: "agent.finished", agentId: inner }]);
    expect(at(mapped, 13).events).toMatchObject([{ type: "agent.finished", agentId: outer }]);
  });

  it("marks nothing heuristic", () => {
    expect(JSON.stringify(allEvents(mapped))).not.toContain("heuristic");
  });
});

describe("subagent/parallel", () => {
  const mapped = replay("subagent/parallel");
  const events = allEvents(mapped);

  it("parents both background subagents on the main session", () => {
    const links = of(events, "agent.registered").filter((e) => "parentAgentId" in e.payload);
    expect(links.map((e) => e.payload.parentAgentId)).toEqual([
      "cc:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5",
      "cc:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5",
    ]);
    expect(of(events, "agent.finished")).toHaveLength(2);
  });
});

describe("team/in-process", () => {
  const mapped = replay("team/in-process");
  const events = allEvents(mapped);
  const lead = "cc:cf46f41b-8048-4a06-b955-b342dd0c7f31";
  const pip = `${lead}:apip-5cb5e9bb3f2f1097`;
  const bo = `${lead}:abo-4381c522227780d5`;
  const team = "cc-team:session-cf46f41b";

  it("detects the lead and registers each teammate from the teammate_spawned response", () => {
    expect(at(mapped, 19).events).toMatchObject([
      { type: "team.started", payload: { teamId: team, leadAgentId: lead } },
      { type: "agent.registered", agentId: lead, payload: { kind: "lead", teamId: team } },
      {
        type: "agent.registered",
        agentId: pip,
        payload: { kind: "teammate", displayName: "pip", teamId: team },
      },
    ]);
  });

  it("treats SubagentStop and TeammateIdle on a teammate as idle, never finished (#120 D3)", () => {
    expect(of(events, "agent.finished")).toEqual([]);
    expect(at(mapped, 35).events).toMatchObject([{ type: "activity.ended", agentId: bo }]);
    expect(at(mapped, 36).events).toMatchObject([
      { type: "agent.registered", agentId: bo, payload: { kind: "teammate", teamId: team } },
      { type: "activity.ended", agentId: bo },
    ]);
  });

  it("emits nothing for a teammate's per-turn SubagentStart", () => {
    expect(at(mapped, 20).events).toEqual([]);
    expect(at(mapped, 48).events).toEqual([]);
  });

  it("ignores internal helper agents", () => {
    for (const seq of [34, 51, 76, 77]) expect(at(mapped, seq).events).toEqual([]);
  });

  it("maps SendMessage into team.message from the calling agent", () => {
    expect(at(mapped, 40).events).toMatchObject([
      {
        type: "team.message",
        agentId: pip,
        payload: { to: "bo", kind: "message", summary: "Greeting bo from pip" },
      },
    ]);
    expect(at(mapped, 57).events).toMatchObject([
      { type: "team.message", agentId: lead, payload: { to: "pip", kind: "shutdown_request" } },
    ]);
    expect(at(mapped, 70).events).toMatchObject([
      {
        type: "team.message",
        agentId: bo,
        payload: { to: "team-lead", kind: "shutdown_response" },
      },
    ]);
  });

  it("marks nothing heuristic, since in-process attribution uses recorded fields only", () => {
    expect(JSON.stringify(events)).not.toContain("heuristic");
  });
});

describe("team/split-pane", () => {
  const mapped = replay("team/split-pane");
  const events = allEvents(mapped);
  const lead = "cc:a7286c33-05b8-4a44-af6b-76733867aab0";
  const team = "cc-team:session-a7286c33";

  it("registers no agent for a split-pane spawn, whose agent_id never appears in its hooks", () => {
    const spawn = at(mapped, 3).events;
    expect(spawn.map((e) => e.type)).toEqual(["team.started", "agent.registered"]);
    expect(spawn[1]).toMatchObject({ agentId: lead, payload: { kind: "lead" } });
  });

  it("shows a worker permission prompt red on the lead, for the teammate, as heuristic", () => {
    expect(at(mapped, 17).events).toMatchObject([
      {
        type: "request.opened",
        agentId: lead,
        payload: { kind: "permission", toolName: "Bash", reason: "for: pip", heuristic: true },
      },
    ]);
  });

  it("links a split-pane teammate session on TeammateIdle, as a recorded fact", () => {
    const [registration, idle] = at(mapped, 27).events;
    expect(registration).toMatchObject({
      type: "agent.registered",
      agentId: "cc:f1b7a717-fe78-44d8-b68b-a12643262b81",
      payload: { kind: "teammate", displayName: "bo", teamId: team },
    });
    expect(registration?.payload).not.toHaveProperty("heuristic");
    expect(idle).toMatchObject({ type: "activity.ended" });
  });

  it("names a teammate from its first SendMessage before any TeammateIdle, as heuristic", () => {
    const [message, link] = at(mapped, 37).events;
    expect(message).toMatchObject({
      type: "team.message",
      agentId: "cc:cf7d0732-a271-4cf7-9a11-d0918b72fbd0",
      payload: { to: "bo" },
    });
    expect(link).toMatchObject({
      type: "agent.registered",
      agentId: message?.agentId,
      payload: { kind: "teammate", displayName: "pip", heuristic: true },
    });
    expect(link?.payload).not.toHaveProperty("teamId");
  });

  it("never treats the lead's own messages as a teammate link", () => {
    for (const e of of(events, "agent.registered")) {
      if (e.agentId === lead) expect(e.payload.kind).toBe("lead");
    }
  });
});

describe("team/split-pane-speculative", () => {
  const mapped = replay("team/split-pane-speculative");

  it("ignores the helper agent whose PreToolUse never gets a Post", () => {
    expect(at(mapped, 30).events).toEqual([]);
    expect(at(mapped, 32).events).toEqual([]);
  });

  it("names pip from its SendMessage (seq 34) before its first idle (seq 51)", () => {
    const link = of(at(mapped, 34).events, "agent.registered")[0];
    expect(link).toMatchObject({ payload: { displayName: "pip", heuristic: true } });
  });
});
