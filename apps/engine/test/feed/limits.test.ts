import { describe, expect, it } from "vitest";
import {
  type CrewResponse,
  ingestRaw,
  leadOf,
  PARALLEL,
  runBash,
  SPIKE_CWD,
  toolCallFrames,
  toolCallSequences,
  useHarness,
} from "./helpers.ts";

// M5.01 pins for paths the first test round left open: a backlog longer than one read page, the
// crew's cycle guard, a stalled client, and a crew for an agent retention dropped.

const start = useHarness();
const SESSION = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("feed backlog over more than one read page", () => {
  it("delivers every frame, complete and in order, when the log spans several 256-event pages", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    const calls = 300;
    for (let i = 0; i < calls; i++) {
      await runBash(h, {
        session: SESSION,
        toolUseId: `toolu_page${String(i).padStart(4, "0")}`,
        command: `echo ${i}`,
        stdout: `${i}\n`,
        label: `page${i}`,
      });
    }
    // More than two pages of events in the project, and every call started and finished.
    expect(h.events("spike").length).toBeGreaterThan(256 * 2);
    const expected = toolCallSequences(h.events("spike"), leadOf(SESSION));
    expect(expected).toHaveLength(calls * 2);

    const reader = await h.openFeed(leadOf(SESSION));
    const frames = await toolCallFrames(reader, calls * 2);
    await reader.cancel();

    expect(frames.map((f) => f.id)).toEqual(expected);
    expect(frames.map((f) => f.data.toolCallId)).toEqual(
      Array.from({ length: calls }, (_, i) => {
        const id = `toolu_page${String(i).padStart(4, "0")}`;
        return [id, id];
      }).flat(),
    );
    expect(frames.map((f) => f.data.phase)).toEqual(
      Array.from({ length: calls }, () => ["running", "succeeded"]).flat(),
    );
  });
});

describe("GET /v1/agents/:id/crew: crafted data and retention", () => {
  const registration = (parentAgentId: string, displayName: string) => ({
    sourceAgentId: displayName,
    displayName,
    role: "general-purpose",
    kind: "subagent",
    parentAgentId,
  });

  it("ends a parent loop at the first repeat instead of recursing forever", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    const at = "2026-10-31T11:00:00.000Z";
    ingestRaw(h, "spike", "loop", [
      { type: "agent.registered", agentId: "loop-a", at, payload: registration("loop-b", "a") },
      { type: "agent.registered", agentId: "loop-b", at, payload: registration("loop-a", "b") },
      { type: "agent.registered", agentId: "loop-c", at, payload: registration("loop-c", "c") },
    ]);

    const res = await h.crew("loop-a");
    expect(res.status).toBe(200);
    const crew = (await res.json()) as CrewResponse;
    expect(crew.subagents.map((m) => m.agentId)).toEqual(["loop-b"]);
    // b's own child would be a again, which is already on the path.
    expect(crew.subagents[0]?.children).toEqual([]);

    const self = (await (await h.crew("loop-c")).json()) as CrewResponse;
    expect(self.subagents).toEqual([]);
  });

  it("answers 200 with an empty crew for an agent the projection no longer holds, and lists no dropped member", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    const lead = "ret-lead";
    const total = 53;
    const at = (i: number) =>
      new Date(Date.parse("2026-10-31T11:00:00.000Z") + i * 1000).toISOString();
    ingestRaw(h, "spike", "ret-lead", [
      {
        type: "agent.registered",
        agentId: lead,
        at: at(0),
        payload: { sourceAgentId: lead, displayName: "lead", role: "lead", kind: "lead" },
      },
    ]);
    for (let i = 0; i < total; i++) {
      const id = `ret-sub-${String(i).padStart(2, "0")}`;
      ingestRaw(h, "spike", id, [
        {
          type: "agent.registered",
          agentId: id,
          at: at(1 + i * 2),
          payload: registration(lead, id),
        },
        {
          type: "agent.finished",
          agentId: id,
          at: at(2 + i * 2),
          payload: { summary: `done ${i}` },
        },
      ]);
    }

    // The reducer keeps the 50 newest finished agents; the three oldest are dropped from the
    // projection while their events remain in the log.
    const stored = h.engine.storage.projection<{ agents: Record<string, unknown> }>("spike");
    expect(Object.keys(stored?.state.agents ?? {})).toContain("ret-sub-52");
    expect(Object.keys(stored?.state.agents ?? {})).not.toContain("ret-sub-00");

    const parent = (await (await h.crew(lead)).json()) as CrewResponse;
    expect(parent.subagents).toHaveLength(50);
    expect(parent.subagents.map((m) => m.agentId)).not.toContain("ret-sub-00");
    expect(parent.subagents.map((m) => m.agentId)).toContain("ret-sub-52");

    const res = await h.crew("ret-sub-00");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agentId: "ret-sub-00",
      projectId: "spike",
      subagents: [],
      teammates: [],
    });
  });
});

describe("a stalled feed client", () => {
  it("is cut off after the drain timeout and frees its stream slot", async () => {
    const h = await start({ drainTimeoutMs: 50, maxStreams: 1 });
    h.addProject("spike", SPIKE_CWD);
    await h.play(PARALLEL.file);

    const stalled = await h.feed(PARALLEL.a); // never read
    expect(stalled.status).toBe(200);
    expect(h.engine.hub.openStreams()).toBe(1);
    expect((await h.feed(PARALLEL.a)).status).toBe(503);

    await waitFor(() => h.engine.hub.openStreams() === 0);
    expect(h.engine.hub.openStreams()).toBe(0);

    const next = await h.feed(PARALLEL.a);
    expect(next.status).toBe(200);
    await next.body?.cancel();
    await stalled.body?.cancel();
  });
});
