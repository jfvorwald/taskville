import { describe, expect, it } from "vitest";
import {
  type CrewResponse,
  type EvidenceResponse,
  evidenceIdsOf,
  expectQuiet,
  ingestRaw,
  leadOf,
  PARALLEL,
  runBash,
  SPIKE_CWD,
  toolCallFrames,
  useHarness,
} from "./helpers.ts";

// M5.01 review-fix round (code review: coverage; security review: two DoS mediums). Each test
// says whether it passes on the current source or must fail until the fix lands.

const start = useHarness();
const SESSION = "7e6d5c4b-3a29-4180-8f6e-5d4c3b2a1908";
const AGENT = leadOf(SESSION);
const T0 = Date.parse("2026-10-31T11:00:00.000Z");
const at = (i: number) => new Date(T0 + i * 1000).toISOString();

type H = Awaited<ReturnType<typeof start>>;

// --- 1. Heartbeat on the route ---

describe("feed heartbeat over the route", () => {
  // Pass now. Mutations: drop the catch-up heartbeat; send `{ head: 0 }` from the idle branch.
  it("sends a heartbeat with the project head right after the backlog, then repeats it with the current head", async () => {
    const h = await start({ heartbeatMs: 400 });
    h.addProject("spike", SPIKE_CWD);
    await runBash(h, {
      session: SESSION,
      toolUseId: "toolu_hb_a",
      command: "a",
      stdout: "a\n",
      label: "hba",
    });
    const head = h.engine.storage.head("spike") ?? 0;

    const reader = await h.openFeed(AGENT);
    const first = await reader.next();
    const second = await reader.next();
    expect([first?.event, second?.event]).toEqual(["toolcall", "toolcall"]);
    // After the backlog (and a turn of the event loop), well before the 400 ms timer.
    const caughtUp = await reader.next(200);
    expect(caughtUp?.event).toBe("heartbeat");
    expect(caughtUp?.data).toEqual({ head });
    expect(caughtUp).not.toHaveProperty("id");

    // The timer repeats it, with the head it has then.
    const repeated = await reader.next(1500);
    expect(repeated?.event).toBe("heartbeat");
    expect(repeated?.data).toEqual({ head });

    await runBash(h, { session: SESSION, toolUseId: "toolu_hb_b", command: "b", label: "hbb" });
    const live = await toolCallFrames(reader, 1);
    expect(live[0]?.data.toolCallId).toBe("toolu_hb_b");
    const newHead = h.engine.storage.head("spike") ?? 0;
    expect(newHead).toBeGreaterThan(head);
    for (;;) {
      const frame = await reader.next(1500);
      if (frame?.event !== "heartbeat")
        throw new Error(`expected a heartbeat, got ${frame?.event}`);
      if ((frame.data as { head: number }).head === newHead) break;
      expect(frame.data).toEqual({ head: expect.any(Number) });
    }
    await reader.cancel();
  });
});

// --- 2. Crew: a teammate whose team ended ---

const registration = (kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  sourceAgentId: name,
  displayName: name,
  role: kind === "lead" ? "lead" : "researcher",
  kind,
  ...extra,
});

async function crewOf(h: H, agentId: string): Promise<CrewResponse> {
  const res = await h.crew(agentId);
  expect(res.status).toBe(200);
  return (await res.json()) as CrewResponse;
}

describe("GET /v1/agents/:id/crew: teams that ended", () => {
  // Pass now. Mutation: in crew.ts, `finishedAt` of a teammate ignores `teamOf?.endedAt`.
  it("marks a teammate finished at the team's end when the team ended without the teammate's own finish", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    ingestRaw(h, "spike", "team-end", [
      { type: "agent.registered", agentId: "tl", at: at(0), payload: registration("lead", "tl") },
      {
        type: "team.started",
        agentId: "tl",
        at: at(1),
        payload: { teamId: "team-1", leadAgentId: "tl", name: "crew" },
      },
      {
        type: "agent.registered",
        agentId: "tm-a",
        at: at(2),
        payload: registration("teammate", "tm-a", { teamId: "team-1" }),
      },
      {
        type: "agent.registered",
        agentId: "tm-b",
        at: at(3),
        payload: registration("teammate", "tm-b", { teamId: "team-1" }),
      },
      { type: "agent.finished", agentId: "tm-b", at: at(4), payload: { summary: "b is done" } },
      { type: "team.ended", agentId: "tl", at: at(5), payload: { teamId: "team-1" } },
    ]);

    const crew = await crewOf(h, "tl");
    expect(crew.team).toMatchObject({ id: "team-1", leadAgentId: "tl", endedAt: at(5) });
    expect(crew.teammates.map((m) => m.agentId)).toEqual(["tm-a", "tm-b"]);
    const [a, b] = crew.teammates;
    // Never finished on its own: finished when its team ended, with that time and nothing invented.
    expect(a?.status).toBe("finished");
    expect(a?.finishedAt).toBe(at(5));
    expect(a?.elapsedMs).toBe(3000);
    expect(a).not.toHaveProperty("currentActivity");
    expect(a).not.toHaveProperty("resultSummary");
    // Finished on its own before the team ended: its own time and summary stand.
    expect(b?.status).toBe("finished");
    expect(b?.finishedAt).toBe(at(4));
    expect(b?.elapsedMs).toBe(1000);
    expect(b?.resultSummary).toBe("b is done");
  });

  // Pass now. Mutation: in crew.ts, `finishedAt` of a teammate takes its own `agent.finishedAt`
  // over the team's end even when the team ended first.
  it("keeps the team's end as a teammate's finish when its own agent.finished arrives after the team ended", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    ingestRaw(h, "spike", "late-finish", [
      { type: "agent.registered", agentId: "tl", at: at(0), payload: registration("lead", "tl") },
      {
        type: "team.started",
        agentId: "tl",
        at: at(1),
        payload: { teamId: "team-1", leadAgentId: "tl", name: "crew" },
      },
      {
        type: "agent.registered",
        agentId: "tm-a",
        at: at(2),
        payload: registration("teammate", "tm-a", { teamId: "team-1" }),
      },
      { type: "team.ended", agentId: "tl", at: at(5), payload: { teamId: "team-1" } },
      { type: "agent.finished", agentId: "tm-a", at: at(8), payload: { summary: "a, late" } },
    ]);

    const crew = await crewOf(h, "tl");
    expect(crew.team).toMatchObject({ id: "team-1", endedAt: at(5) });
    const [a] = crew.teammates;
    expect(a?.agentId).toBe("tm-a");
    expect(a?.status).toBe("finished");
    // The earlier of its own finish (8 s) and its team's end (5 s): not moved later by the late finish.
    expect(a?.finishedAt).toBe(at(5));
    expect(a?.elapsedMs).toBe(3000);
    expect(a?.resultSummary).toBe("a, late");
  });

  // Fail now: crew.ts takes the first team led by the agent (`teams.find`), which here is the one
  // that ended. A lead that ran two teams in sequence gets the one that is running.
  it("gives a lead that ran two teams in sequence the running one, with its teammates", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    ingestRaw(h, "spike", "two-teams", [
      { type: "agent.registered", agentId: "tl", at: at(0), payload: registration("lead", "tl") },
      {
        type: "team.started",
        agentId: "tl",
        at: at(1),
        payload: { teamId: "team-1", leadAgentId: "tl", name: "first" },
      },
      {
        type: "agent.registered",
        agentId: "tm-1",
        at: at(2),
        payload: registration("teammate", "tm-1", { teamId: "team-1" }),
      },
      { type: "team.ended", agentId: "tl", at: at(3), payload: { teamId: "team-1" } },
      {
        type: "team.started",
        agentId: "tl",
        at: at(4),
        payload: { teamId: "team-2", leadAgentId: "tl", name: "second" },
      },
      {
        type: "agent.registered",
        agentId: "tm-2",
        at: at(5),
        payload: registration("teammate", "tm-2", { teamId: "team-2" }),
      },
    ]);

    const crew = await crewOf(h, "tl");
    expect(crew.team?.id).toBe("team-2");
    expect(crew.team).not.toHaveProperty("endedAt");
    expect(crew.teammates.map((m) => m.agentId)).toEqual(["tm-2"]);
    expect(crew.teammates[0]?.status).toBe("running");
    // A teammate of the running team still sees it as its own.
    expect((await crewOf(h, "tm-2")).team?.id).toBe("team-2");
  });
});

// --- 4 and 5. Unfinished calls and their evidence ---

const stopHook = () => ({
  session_id: SESSION,
  cwd: SPIKE_CWD,
  permission_mode: "default",
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "Turn over.",
});

const postHook = (toolUseId: string) => ({
  session_id: SESSION,
  cwd: SPIKE_CWD,
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: "echo late", description: "late" },
  tool_use_id: toolUseId,
  hook_event_name: "PostToolUse",
  tool_response: {
    stdout: "the late output\n",
    stderr: "",
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  },
  duration_ms: 12,
});

describe("unfinished calls in the feed", () => {
  // Pass now. Mutation: frameEvidence shows `output` for an `unfinished` frame (only `running`
  // hides it).
  it("shows no output evidence on the unfinished frame, even once the late result was stored", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await runBash(h, {
      session: SESSION,
      toolUseId: "toolu_late",
      command: "echo late",
      label: "late",
    });
    await h.hook(stopHook(), "late#stop");
    await h.hook(postHook("toolu_late"), "late#post");

    // A fresh connection: the backlog is read after the output was stored.
    const reader = await h.openFeed(AGENT);
    const frames = await toolCallFrames(reader, 3);
    await expectQuiet(reader);
    await reader.cancel();
    expect(frames.map((f) => f.data.phase)).toEqual(["running", "unfinished", "succeeded"]);
    const [running, unfinished, succeeded] = frames.map((f) => f.data);
    expect(running?.evidence.output).toBeNull();
    expect(unfinished).not.toHaveProperty("durationMs");
    expect(unfinished?.evidence.input?.status).toBe("stored");
    expect(unfinished?.evidence.output).toBeNull();
    expect(succeeded?.durationMs).toBe(12);
    expect(succeeded?.evidence.input?.status).toBe("stored");
    expect(succeeded?.evidence.output?.status).toBe("stored");

    const res = await h.evidenceBody(succeeded?.evidence.output?.id ?? "");
    expect(res.status).toBe(200);
    expect(((await res.json()) as EvidenceResponse).text).toContain("the late output");
  });

  // Pass now. The reducer closes every running call of a session when it ends, whoever sent the
  // end. Mutations: the tracker folds only its own agent's events into the reducer (kills the
  // second test); `#closedByBoundary` skips session.ended (kills both).
  describe("when the session ends", () => {
    it("closes the agent's own call at session.ended", async () => {
      const h = await start();
      h.addProject("spike", SPIKE_CWD);
      ingestRaw(h, "spike", "own-end", [
        {
          type: "tool_call.started",
          agentId: "solo",
          sessionId: "sess-solo",
          at: at(0),
          payload: { toolCallId: "toolu_solo", toolName: "Bash" },
        },
        {
          type: "session.ended",
          agentId: "solo",
          sessionId: "sess-solo",
          at: at(5),
          payload: {},
        },
      ]);
      const reader = await h.openFeed("solo");
      const frames = await toolCallFrames(reader, 2);
      await reader.cancel();
      expect(frames.map((f) => f.data.phase)).toEqual(["running", "unfinished"]);
      const ended = h.events("spike").find((e) => e.type === "session.ended");
      expect(frames[1]?.id).toBe(ended?.ingestSequence);
      expect(frames[1]?.data.finishedAt).toBe(at(5));
      expect(frames[1]?.data).not.toHaveProperty("durationMs");
      expect(frames[1]?.data.toolName).toBe("Bash");
      expect(frames[1]?.data.evidence.output).toBeNull();
    });

    it("closes another agent's call in the session, sent live to an open feed", async () => {
      const h = await start();
      h.addProject("spike", SPIKE_CWD);
      ingestRaw(h, "spike", "helper", [
        {
          type: "tool_call.started",
          agentId: "helper",
          sessionId: "sess-shared",
          at: at(0),
          payload: { toolCallId: "toolu_helper", toolName: "Read" },
        },
      ]);
      const reader = await h.openFeed("helper");
      const [running] = await toolCallFrames(reader, 1);
      expect(running?.data.phase).toBe("running");

      ingestRaw(h, "spike", "owner-ends", [
        {
          type: "session.ended",
          agentId: "owner",
          sessionId: "sess-shared",
          at: at(9),
          payload: {},
        },
      ]);
      const [closed] = await toolCallFrames(reader, 1);
      await reader.cancel();
      expect(closed?.data.toolCallId).toBe("toolu_helper");
      expect(closed?.data.phase).toBe("unfinished");
      expect(closed?.data.finishedAt).toBe(at(9));
      expect(closed?.id).toBe(h.engine.storage.head("spike"));
    });
  });
});

// --- 6. Evidence id strictness ---

const enc = (projectId: string, toolCallId: string, part: string): string =>
  Buffer.from(JSON.stringify([projectId, toolCallId, part]), "utf8").toString("base64url");
const b64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

describe("GET /v1/evidence/:id: ids", () => {
  async function seed(h: H) {
    h.addProject("spike", SPIKE_CWD);
    // Tool call IDs of three lengths, so at least one id has unused bits in its last base64 char.
    const calls = ["toolu_ev", "toolu_ev1", "toolu_ev22"];
    for (const call of calls) {
      await runBash(h, {
        session: SESSION,
        toolUseId: call,
        command: call,
        stdout: `${call}\n`,
        label: call,
      });
    }
    await runBash(h, { session: SESSION, toolUseId: "toolu_open", command: "open", label: "open" });
    return calls;
  }

  // Pass now. Mutation: drop the `evidenceId(...) !== id` canonical check in parseEvidenceId.
  // Contract: "404 unknown_evidence for an ID that was never handed out"; one body has one id.
  it("answers 404 unknown_evidence for any other encoding of a valid id", async () => {
    const h = await start();
    const calls = await seed(h);
    let aliased = 0;
    for (const call of calls) {
      const ids = await evidenceIdsOf(h, AGENT, call);
      const canonical = enc("spike", call, "input");
      expect(canonical).toBe(ids.input);
      expect((await h.evidenceBody(canonical)).status).toBe(200);

      const variants: Record<string, string> = {
        "json with spaces": b64url(`[ "spike", "${call}", "input" ]`),
        "json with an escape": b64url(`["\\u0073pike","${call}","input"]`),
        "json as an object": b64url(
          JSON.stringify({ projectId: "spike", toolCallId: call, part: "input" }),
        ),
        "fields reordered": b64url(JSON.stringify(["spike", "input", call])),
        "parts reordered": b64url(JSON.stringify([call, "spike", "input"])),
      };
      const pad = (4 - (canonical.length % 4)) % 4;
      if (pad > 0) variants["padded base64"] = `${canonical}${"=".repeat(pad)}`;
      // The last char carries bits the decoder ignores: another char decodes to the same bytes.
      if (pad > 0) {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        const alias = alphabet[alphabet.indexOf(canonical.slice(-1)) | 1] as string;
        const aliased64 = canonical.slice(0, -1) + alias;
        expect(aliased64).not.toBe(canonical);
        expect(
          Buffer.from(aliased64, "base64url").equals(Buffer.from(canonical, "base64url")),
        ).toBe(true);
        variants["last char with ignored bits"] = aliased64;
        aliased++;
      }
      for (const [name, id] of Object.entries(variants)) {
        const res = await h.evidenceBody(id);
        expect(res.status, `${call}: ${name}`).toBe(404);
        expect(await res.json()).toEqual({
          error: { code: "unknown_evidence", message: expect.any(String) },
        });
      }
    }
    expect(aliased).toBeGreaterThan(0);
  });

  // Pass now. Mutation: in the evidence route, look the body up under a fixed project.
  it("answers 404 unknown_evidence for a well-formed id whose project or part holds nothing", async () => {
    const h = await start();
    await seed(h);
    const wellFormed: Record<string, string> = {
      "another project": enc("ghost", "toolu_ev", "input"),
      "a call never made": enc("spike", "toolu_never", "input"),
      "the output of a call that has none yet": enc("spike", "toolu_open", "output"),
      "an input of a call whose project is another": enc("ghost", "toolu_open", "input"),
    };
    for (const [name, id] of Object.entries(wellFormed)) {
      const res = await h.evidenceBody(id);
      expect(res.status, name).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "unknown_evidence", message: expect.any(String) },
      });
    }
    // The input of the open call is stored, so that id is fine.
    expect((await h.evidenceBody(enc("spike", "toolu_open", "input"))).status).toBe(200);
  });
});

// --- 7 (route part). The feed serves every call, however many are left open ---

describe("feed of an agent with more open calls than the reducer keeps", () => {
  // Pass now (the tracker bound itself is pinned in subscriber.test.ts). The frames already sent
  // for calls the reducer dropped stay as sent.
  it("serves a running frame for every call, in order, and the finish of the latest one live", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    const total = 40;
    ingestRaw(
      h,
      "spike",
      "many",
      Array.from({ length: total }, (_, i) => ({
        type: "tool_call.started",
        agentId: "many",
        at: at(i),
        payload: { toolCallId: `toolu_many_${String(i).padStart(2, "0")}`, toolName: "Bash" },
      })),
    );
    const reader = await h.openFeed("many");
    const frames = await toolCallFrames(reader, total);
    expect(frames.map((f) => f.data.toolCallId)).toEqual(
      Array.from({ length: total }, (_, i) => `toolu_many_${String(i).padStart(2, "0")}`),
    );
    expect(new Set(frames.map((f) => f.data.phase))).toEqual(new Set(["running"]));
    await expectQuiet(reader);

    ingestRaw(h, "spike", "many-done", [
      {
        type: "tool_call.finished",
        agentId: "many",
        at: at(total + 1),
        payload: { toolCallId: `toolu_many_${total - 1}`, phase: "succeeded", durationMs: 3 },
      },
    ]);
    const [done] = await toolCallFrames(reader, 1);
    await reader.cancel();
    expect(done?.data.toolCallId).toBe(`toolu_many_${total - 1}`);
    expect(done?.data.phase).toBe("succeeded");
  });
});

// --- 8. The stream cap comes before agent resolution ---

describe("feed stream cap (security review M1)", () => {
  // Fail now: the route resolves the agent first, so with the cap full an unknown agent costs a
  // scan of every project's log and answers 404. The cap is checked before any lookup.
  it("answers 503 too_many_streams, not 404, for an unknown agent while the cap is full", async () => {
    const h = await start({ maxStreams: 1 });
    h.addProject("spike", SPIKE_CWD);
    await h.play(PARALLEL.file);

    const held = await h.feed(PARALLEL.a); // never read: holds the one slot
    expect(held.status).toBe(200);
    expect(h.engine.hub.openStreams()).toBe(1);

    for (const [name, res] of [
      ["unknown agent", await h.feed("claude-code:no-such-agent")],
      [
        "unknown agent in a named project",
        await h.feed("claude-code:no-such-agent", "?projectId=spike"),
      ],
      ["unknown project", await h.feed(PARALLEL.a, "?projectId=no-such-project")],
    ] as const) {
      expect(res.status, name).toBe(503);
      expect(await res.json(), name).toEqual({
        error: { code: "too_many_streams", message: expect.any(String) },
      });
    }
    await held.body?.cancel();
  });
});
