import { readFileSync } from "node:fs";
import type { SSEStreamingApi } from "hono/streaming";
import { afterEach, describe, expect, it } from "vitest";
import { FeedSubscriber } from "../../src/feed/subscriber.ts";
import { ToolCallTracker } from "../../src/feed/tool-calls.ts";
import { domainReducer } from "../../src/ingest/index.ts";
import * as storageModule from "../../src/storage/storage.ts";
import { expireOpenRequests } from "../../src/stream/index.ts";
import type { SseReader } from "../stream/helpers.ts";
import { ingestRaw, SPIKE_CWD, useHarness } from "./helpers.ts";
import { countRows } from "./subset-rows.ts";

// M5.14 red round 2 (roborev 6880, code review): the feed folds a SUBSET of the project's events
// through `Storage.agentFeedEvents`, and the subset must give the same frames as a fold of the
// whole log. Lead invariant: the subset contains every event that can change the tracker's closure
// state: (a) the agent's own events, (b) every event in any session the agent ever appears in,
// whole log and not only after the cursor, (c) every `agent.registered` and (d) every
// `agent.finished` event of the project (the retention inputs; bounded by agent count).
//
// Reference: a `ToolCallTracker` over `storage.events(project, 0)` (the full fold), framed like the
// feed (only the last frame of an event carries its id). Actual: the real route, backlog read at
// `?after=0` and resumed at other cursors. One project per case, each agent of it compared.
// Mutation per part (done by hand against a temporary query, never committed): without (a) the
// own-events cases fail; without (b) the owner/late-entry cases; without (c) case 4; without (d)
// cases 1 and 2.

const start = useHarness();
type H = Awaited<ReturnType<typeof start>>;
type Raw = Parameters<typeof ingestRaw>[3][number];

const T0 = Date.parse("2026-10-31T10:00:00.000Z");
let tick = 0;
const at = () => new Date(T0 + 1000 * tick++).toISOString();

const reg = (agentId: string, sessionId: string | undefined, parent?: string): Raw => ({
  type: "agent.registered",
  agentId,
  ...(sessionId === undefined ? {} : { sessionId }),
  at: at(),
  payload: {
    sourceAgentId: agentId,
    displayName: agentId,
    role: "helper",
    kind: "subagent",
    ...(parent === undefined ? {} : { parentAgentId: parent }),
  },
});
const ev = (type: string, agentId: string, sessionId?: string, payload = {}): Raw => ({
  type,
  agentId,
  ...(sessionId === undefined ? {} : { sessionId }),
  at: at(),
  payload,
});
const call = (agentId: string, sessionId: string, id: string): Raw =>
  ev("tool_call.started", agentId, sessionId, { toolCallId: id, toolName: "Bash" });
const done = (agentId: string, sessionId: string, id: string): Raw =>
  ev("tool_call.finished", agentId, sessionId, { toolCallId: id, phase: "succeeded" });

/** 55 other agents finish in other sessions, later than anything before: retention keeps 50. */
const finishers = (tag: string): Raw[] =>
  Array.from({ length: 55 }, (_, i) =>
    ev("agent.finished", `${tag}-fin-${i}`, `${tag}-fin-session-${i}`),
  );

function ingestAll(h: H, project: string, label: string, events: Raw[]): void {
  for (let i = 0; i < events.length; i += 40) {
    ingestRaw(h, project, `${label}-${i}`, events.slice(i, i + 40));
  }
}

interface Sig {
  id: number;
  toolCallId: string;
  phase: string;
  startedAt?: string;
  finishedAt?: string;
}

function fullFold(h: H, project: string, agentId: string, after: number): Sig[] {
  const tracker = new ToolCallTracker(project, agentId);
  const out: Sig[] = [];
  for (const event of h.engine.storage.events(project, 0)) {
    const calls = tracker.applyAll(event);
    calls.forEach((c, i) => {
      if (event.ingestSequence <= after) return;
      out.push({
        id: i === calls.length - 1 ? event.ingestSequence : -1,
        toolCallId: c.toolCallId,
        phase: c.phase,
        ...(c.startedAt === undefined ? {} : { startedAt: c.startedAt }),
        ...(c.finishedAt === undefined ? {} : { finishedAt: c.finishedAt }),
      });
    });
  }
  return out;
}

async function viaRoute(h: H, project: string, agentId: string, after: number): Promise<Sig[]> {
  const reader: SseReader = await h.openFeed(agentId, `?projectId=${project}&after=${after}`);
  const out: Sig[] = [];
  try {
    for (;;) {
      const frame = await reader.next(5000);
      if (frame === null || frame.event === "heartbeat") return out;
      if (frame.event !== "toolcall") continue;
      const d = frame.data as Sig & { toolCallId: string };
      out.push({
        id: frame.id ?? -1,
        toolCallId: d.toolCallId,
        phase: d.phase,
        ...(d.startedAt === undefined ? {} : { startedAt: d.startedAt }),
        ...(d.finishedAt === undefined ? {} : { finishedAt: d.finishedAt }),
      });
    }
  } finally {
    await reader.cancel();
  }
}

/** Every agent of the project: backlog from 0 and resumes at the first and the last frame ids. */
async function expectEquivalent(h: H, project: string): Promise<string[]> {
  const agents = new Set<string>();
  for (const e of h.engine.storage.events(project, 0)) if (e.agentId) agents.add(e.agentId);
  const diverged: string[] = [];
  for (const agentId of agents) {
    const whole = fullFold(h, project, agentId, 0);
    const ids = whole.map((f) => f.id).filter((id) => id > 0);
    const cursors = [...new Set([0, ids[0] ?? 0, ids.at(-1) ?? 0])];
    for (const after of cursors) {
      const expected = fullFold(h, project, agentId, after);
      const actual = await viaRoute(h, project, agentId, after);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        diverged.push(`${agentId} after=${after}`);
      }
    }
  }
  return diverged;
}

describe("the subset fold equals the full fold", () => {
  it("case 1: a finished registered helper dropped by retention, then re-created, is closed by its owner's turn end", async () => {
    const h = await start();
    h.addProject("c1", SPIKE_CWD);
    ingestAll(h, "c1", "c1", [
      ev("session.started", "c1-owner", "c1-s"),
      reg("c1-helper", "c1-s", "c1-owner"),
      call("c1-helper", "c1-s", "toolu_c1_a"),
      done("c1-helper", "c1-s", "toolu_c1_a"),
      ev("agent.finished", "c1-helper", "c1-s"),
      ...finishers("c1"),
      call("c1-helper", "c1-s", "toolu_c1_b"),
      ev("session.turn_ended", "c1-owner", "c1-s"),
    ]);
    // Premise: the full fold shows the re-created helper's call closed.
    expect(fullFold(h, "c1", "c1-helper", 0).at(-1)).toMatchObject({
      toolCallId: "toolu_c1_b",
      phase: "unfinished",
    });
    expect(await expectEquivalent(h, "c1")).toEqual([]);
  });

  it("case 2: a finished session owner dropped by retention gives way to a new owner", async () => {
    const h = await start();
    h.addProject("c2", SPIKE_CWD);
    ingestAll(h, "c2", "c2", [
      ev("session.started", "c2-old", "c2-s"),
      ev("agent.finished", "c2-old", "c2-s"),
      ...finishers("c2"),
      ev("session.prompt_submitted", "c2-new", "c2-s"),
      call("c2-helper", "c2-s", "toolu_c2_a"),
      ev("session.turn_ended", "c2-new", "c2-s"),
    ]);
    expect(fullFold(h, "c2", "c2-helper", 0).at(-1)).toMatchObject({
      toolCallId: "toolu_c2_a",
      phase: "unfinished",
    });
    expect(await expectEquivalent(h, "c2")).toEqual([]);
  });

  // The registration of another agent can keep this agent's record: retention never drops the
  // parent of an unfinished agent. So a child's `agent.registered` (here with no sessionId, and for
  // case 5 in a session the helper is not in) must reach the helper's fold.
  const parentKept = (c: string, kSession: string | undefined, kCallSession: string): Raw[] => [
    ev("session.started", `${c}-owner`, `${c}-s`),
    reg(`${c}-helper`, `${c}-s`, `${c}-owner`),
    call(`${c}-helper`, `${c}-s`, `toolu_${c}_a`),
    done(`${c}-helper`, `${c}-s`, `toolu_${c}_a`),
    ev("agent.finished", `${c}-helper`, `${c}-s`),
    reg(`${c}-kid`, kSession, `${c}-helper`),
    call(`${c}-kid`, kCallSession, `toolu_${c}_kid`),
    ...finishers(c),
    call(`${c}-helper`, `${c}-s`, `toolu_${c}_b`),
    ev("session.turn_ended", `${c}-owner`, `${c}-s`),
  ];

  it("case 4 (review L4): a mate's registration without a sessionId still reaches the subset", async () => {
    const h = await start();
    h.addProject("c4", SPIKE_CWD);
    ingestAll(h, "c4", "c4", parentKept("c4", undefined, "c4-s"));
    // The unfinished child keeps its parent through retention: the helper is still registered, so
    // its owner's turn end leaves the call running.
    expect(fullFold(h, "c4", "c4-helper", 0).at(-1)).toMatchObject({
      toolCallId: "toolu_c4_b",
      phase: "running",
    });
    expect(await expectEquivalent(h, "c4")).toEqual([]);
  });

  it("case 5: a registration of an agent in no shared session still reaches the subset", async () => {
    const h = await start();
    h.addProject("c5", SPIKE_CWD);
    ingestAll(h, "c5", "c5", parentKept("c5", "c5-kid-session", "c5-kid-session"));
    expect(fullFold(h, "c5", "c5-helper", 0).at(-1)).toMatchObject({
      toolCallId: "toolu_c5_b",
      phase: "running",
    });
    expect(await expectEquivalent(h, "c5")).toEqual([]);
  });
});

// Roborev 7827: the reducer also keeps and drops agents on events that name NO agent. The index
// holds only events with an agentId, so the subset must still bring these in. Found in
// `packages/domain/src/reducer/retention.ts` and its inputs: `team.started` and `team.ended`
// (a team that has not ended keeps its lead), and `request.resolved` and `request.expired` (engine
// source; they close an open request, and an agent with an open request is kept) an agentless
// (the bridge's `request.resolved` carries an agentId, so it is indexed; only the boot-time
// `request.expired` is agentless in practice). Session events require an agentId at ingest. Task,
// command, project and git events with no agent change nothing retention reads.
type Loose = Omit<Raw, "agentId"> & { agentId?: string };
const loose = (
  type: string,
  fields: { sessionId?: string },
  payload: Record<string, unknown>,
): Loose => ({
  type,
  ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
  at: at(),
  payload,
});

function ingestLoose(h: H, project: string, label: string, events: Loose[]): void {
  for (let i = 0; i < events.length; i += 40) {
    const response = h.engine.pipeline.ingest(
      events.slice(i, i + 40).map((e, j) => ({
        schemaVersion: 1,
        projectId: project,
        sourceId: "adapter:test",
        sourceEventId: `${label}-${i}#${j}`,
        occurredAt: e.at,
        type: e.type,
        ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
        ...(e.sessionId === undefined ? {} : { sessionId: e.sessionId }),
        payload: e.payload,
        provenance: "live",
      })),
    );
    for (const result of response.results) {
      if (result.status !== "accepted")
        throw new Error(`ingest ${label}: ${JSON.stringify(result)}`);
    }
  }
}

describe("the subset fold equals the full fold: agentless retention events (roborev 7827)", () => {
  const lastCall = (h: H, project: string, helper: string) =>
    fullFold(h, project, helper, 0).at(-1);

  it("case 6: an agentless team.started keeps a finished session owner through 55 later finishes", async () => {
    const h = await start();
    h.addProject("c6", SPIKE_CWD);
    ingestLoose(h, "c6", "c6", [
      loose("team.started", {}, { teamId: "c6-team", leadAgentId: "c6-owner" }),
      ev("session.started", "c6-owner", "c6-s"),
      ev("agent.finished", "c6-owner", "c6-s"),
      call("c6-helper", "c6-s", "toolu_c6_a"),
      ...finishers("c6"),
      ev("session.turn_ended", "c6-other", "c6-s"),
    ]);
    // Premise: the team keeps the owner, so another agent's turn end closes nothing.
    expect(lastCall(h, "c6", "c6-helper")).toMatchObject({
      toolCallId: "toolu_c6_a",
      phase: "running",
    });
    expect(await expectEquivalent(h, "c6")).toEqual([]);
  });

  it("case 7: an agentless team.started and team.ended release the owner again", async () => {
    // Passes today (both are dropped); guards a fix that brings in team.started but not team.ended.
    const h = await start();
    h.addProject("c7", SPIKE_CWD);
    ingestLoose(h, "c7", "c7", [
      loose("team.started", {}, { teamId: "c7-team", leadAgentId: "c7-old" }),
      ev("session.started", "c7-old", "c7-s"),
      ev("agent.finished", "c7-old", "c7-s"),
      loose("team.ended", {}, { teamId: "c7-team" }),
      ...finishers("c7"),
      ev("session.prompt_submitted", "c7-new", "c7-s"),
      call("c7-helper", "c7-s", "toolu_c7_a"),
      ev("session.turn_ended", "c7-new", "c7-s"),
    ]);
    expect(lastCall(h, "c7", "c7-helper")).toMatchObject({
      toolCallId: "toolu_c7_a",
      phase: "unfinished",
    });
    expect(await expectEquivalent(h, "c7")).toEqual([]);
  });

  it("case 8: an agentless request.expired (engine boot) releases the owner whose request it closed", async () => {
    const h = await start();
    h.addProject("c8", SPIKE_CWD);
    ingestRaw(h, "c8", "c8-a", [
      ev("session.started", "c8-old", "c8-s"),
      ev("request.opened", "c8-old", "c8-s", { requestId: "c8-req", kind: "permission" }),
      ev("agent.finished", "c8-old", "c8-s"),
    ]);
    // The engine's start rule appends `request.expired` from `taskville:engine`, with no agentId.
    const expired = expireOpenRequests(h.engine.storage, domainReducer, {
      now: () => new Date(at()),
    });
    expect(expired).toEqual([{ projectId: "c8", requestId: "c8-req" }]);
    ingestAll(h, "c8", "c8-b", [
      call("c8-helper", "c8-s", "toolu_c8_a"),
      ...finishers("c8"),
      ev("session.turn_ended", "c8-other", "c8-s"),
    ]);
    expect(lastCall(h, "c8", "c8-helper")).toMatchObject({
      toolCallId: "toolu_c8_a",
      phase: "unfinished",
    });
    expect(await expectEquivalent(h, "c8")).toEqual([]);
  });
});

// Roborev 7838: the subset also left out `request.opened`. An open request keeps its agent through
// retention, and the request can sit in a session other than the one the feed follows.
describe("the subset fold equals the full fold: request.opened in another session (roborev 7838)", () => {
  it("case 9: an owner's open request in another session keeps it through 55 later finishes", async () => {
    const h = await start();
    h.addProject("c9", SPIKE_CWD);
    ingestAll(h, "c9", "c9", [
      ev("session.started", "c9-owner", "c9-s"),
      ev("session.started", "c9-owner", "c9-other-s"),
      ev("request.opened", "c9-owner", "c9-other-s", { requestId: "c9-req", kind: "permission" }),
      ev("agent.finished", "c9-owner", "c9-s"),
      call("c9-helper", "c9-s", "toolu_c9_a"),
      ...finishers("c9"),
      ev("session.turn_ended", "c9-intruder", "c9-s"),
    ]);
    // Premise: the open request keeps the owner, so the intruder's turn end closes nothing.
    expect(fullFold(h, "c9", "c9-helper", 0).at(-1)).toMatchObject({
      toolCallId: "toolu_c9_a",
      phase: "running",
    });
    expect(await expectEquivalent(h, "c9")).toEqual([]);
  });
});

// Structural guard (lead decision on roborev 7838, reshaped in the M5.14 debug round 2). The
// subset fold no longer runs retention: no bounded subset can reproduce it (an open request, an
// unended team or a running call anywhere keeps an agent, and requests close on other sessions'
// events). Instead `ToolCallTracker.needsFullFold` sends the feed to a full fold at the first event
// where a drop of a FINISHED agent could show. That rule is sound only while retention drops
// agents by `finishedAt` and removes with them only what the rule accounts for, and only while the
// subset holds every event type the rule reads. Export of `apps/engine/src/storage/storage.ts`:
// `FEED_PROJECT_WIDE_TYPES`, a ReadonlySet<string> of event types the subset query includes for
// the whole project.
//
// The guard reads the state keys `retention.ts` touches. Each key maps to the event types the
// fallback rule needs project-wide for it. A key that is not in the map fails the test, so a new
// retention input or output has to be classified here, and `needsFullFold` reviewed for it.
describe("the subset holds every event type the full-fold fallback rule reads", () => {
  // agents: which agents have finished (the rule's count and its "finished X"), and which are
  //   registered subagents (never own a session): agent.finished, agent.registered.
  // teams, requests, toolCalls: only decide which finished agents are KEPT. The rule assumes any
  //   finished agent may be dropped, so it needs none of them.
  // activity, sessions, retired: only OUTPUT of a drop; sessions is what the rule watches (an
  //   in-scope session whose owner is finished). tasks: only terminal tasks are dropped.
  const KEY_TYPES: Record<string, readonly string[]> = {
    agents: ["agent.registered", "agent.finished"],
    teams: [],
    requests: [],
    toolCalls: [],
    activity: [],
    sessions: [],
    tasks: [],
    retired: [],
  };

  const retentionKeys = (): string[] => {
    const source = readFileSync(
      new URL("../../../../packages/domain/src/reducer/retention.ts", import.meta.url),
      "utf8",
    );
    return [...new Set([...source.matchAll(/\bs\.([a-zA-Z]+)/g)].map((m) => m[1] as string))];
  };

  it("classifies every state key retention reads", () => {
    const unknown = retentionKeys().filter((k) => !(k in KEY_TYPES));
    expect(unknown).toEqual([]);
    expect(retentionKeys()).toEqual(expect.arrayContaining(["agents", "teams", "requests"]));
  });

  it("FEED_PROJECT_WIDE_TYPES holds every event type the rule needs for those keys", () => {
    const exported = (storageModule as { FEED_PROJECT_WIDE_TYPES?: ReadonlySet<string> })
      .FEED_PROJECT_WIDE_TYPES;
    expect(exported, "storage.ts must export FEED_PROJECT_WIDE_TYPES").toBeInstanceOf(Set);
    const needed = retentionKeys().flatMap((k) => KEY_TYPES[k] ?? []);
    expect(needed.length).toBeGreaterThan(0);
    const missing = needed.filter((t) => !exported?.has(t));
    expect(missing).toEqual([]);
  });
});

// Case 3 needs a feed that folds the log in two reads, so it drives a subscriber that is not
// attached to the hub (as subscriber.test.ts does): a missed broadcast sends it back to storage.
describe("case 3: an agent entering a session another agent named before the cursor", () => {
  const open: FeedSubscriber[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.abort();
  });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("sees that session's earlier events when the second read brings it in", async () => {
    const h = await start();
    h.addProject("c3", SPIKE_CWD);
    ingestRaw(h, "c3", "c3-a", [
      ev("session.started", "c3-owner", "c3-s2"),
      call("c3-x", "c3-s1", "toolu_c3_0"),
      done("c3-x", "c3-s1", "toolu_c3_0"),
    ]);
    const writes: { event: string; data: string; id?: string }[] = [];
    const stream = {
      writeSSE: (m: { event: string; data: string; id?: string }) => {
        writes.push(m);
        return Promise.resolve();
      },
      write: () => Promise.resolve(),
      abort: () => {},
      onAbort: () => {},
    } as unknown as SSEStreamingApi;
    const subscriber = new FeedSubscriber(stream, {
      storage: h.engine.storage,
      evidence: h.evidence,
      projectId: "c3",
      agentId: "c3-x",
      after: 0,
      queueLimit: 1000,
      heartbeatMs: 40,
      drainTimeoutMs: 1000,
    });
    open.push(subscriber);
    void subscriber.run();
    for (let i = 0; i < 200 && !writes.some((w) => w.event === "heartbeat"); i++) await sleep(10);
    expect(writes.some((w) => w.event === "heartbeat")).toBe(true);

    // Not offered to the subscriber: a missed broadcast. x enters the session the owner named; another agent then ends a turn there.
    ingestRaw(h, "c3", "c3-b", [
      call("c3-x", "c3-s2", "toolu_c3_1"),
      ev("session.turn_ended", "c3-intruder", "c3-s2"),
    ]);
    const frames = () =>
      writes
        .filter((w) => w.event === "toolcall")
        .map((w) => JSON.parse(w.data) as { toolCallId: string; phase: string });
    for (let i = 0; i < 200 && !frames().some((f) => f.toolCallId === "toolu_c3_1"); i++) {
      await sleep(10);
    }
    // Settle: a wrongly closing fold would send its extra frame at the next read.
    await sleep(300);

    const expected = fullFold(h, "c3", "c3-x", 0).map((f) => [f.toolCallId, f.phase]);
    // The owner named the session first, so the intruder's turn end closes nothing.
    expect(expected.at(-1)).toEqual(["toolu_c3_1", "running"]);
    expect(frames().map((f) => [f.toolCallId, f.phase])).toEqual(expected);
  });
});

describe("the row bound grows by the agent count and not the log", () => {
  // Pass now, keep green. The invariant adds every agent.registered and agent.finished event of
  // the project to a feed's read: one or two per agent, never one per event. 60 other agents, each
  // with a registration and a finish plus 400 noise events: at most the agent's own events, its
  // session's, and 2 per agent (plus slack), far below the 520 events of the log.
  it("a feed reads its own events plus a registration and a finish per agent, not the noise", async () => {
    const h = await start();
    h.addProject("rb", SPIKE_CWD);
    const others = Array.from({ length: 60 }, (_, i) => `rb-agent-${i}`);
    ingestAll(h, "rb", "rb-agents", [
      ...others.map((a) => reg(a, `rb-session-${a}`)),
      ...others.map((a) => ev("agent.finished", a, `rb-session-${a}`)),
    ]);
    ingestAll(
      h,
      "rb",
      "rb-noise",
      Array.from({ length: 400 }, (_, i) =>
        call(others[i % 60] as string, `rb-session-${others[i % 60]}`, `rb-noise-${i}`),
      ),
    );
    ingestRaw(h, "rb", "rb-self", [call("rb-self", "rb-self-session", "toolu_rb")]);

    const rows = await countRows(async () => {
      const reader = await h.openFeed("rb-self", "?projectId=rb");
      for (;;) {
        const frame = await reader.next(5000);
        if (frame === null || frame.event === "heartbeat") break;
      }
      await reader.cancel();
    });
    const head = h.engine.storage.head("rb") ?? 0;
    expect(head).toBeGreaterThan(500);
    const AGENTS = 61;
    expect(rows).toBeLessThanOrEqual(40 + 2 * AGENTS);
  });
});

// M5.14 regression cases from the debug round (reverse gap and live path of the full-fold
// fallback). Each asserts the full fold's premise (the helper call's final phase) and that the
// feed's frames equal the full fold's, for every agent of the project.
describe("the subset fold equals the full fold: reverse gap and live path", () => {
  const lastPhase = (h: H, project: string, helper: string, toolCallId: string) => {
    const last = fullFold(h, project, helper, 0).at(-1);
    return last?.toolCallId === toolCallId ? last.phase : undefined;
  };
  const permission = (agentId: string, sessionId: string, requestId: string): Raw =>
    ev("request.opened", agentId, sessionId, { requestId, kind: "permission" });

  it("R1 (reverse gap): another agent's turn end in the other session closes the owner's request", async () => {
    const h = await start();
    h.addProject("r1", SPIKE_CWD);
    ingestAll(h, "r1", "r1", [
      ev("session.started", "r1-owner", "r1-s"),
      ev("session.started", "r1-owner", "r1-other"),
      permission("r1-owner", "r1-other", "r1-req"),
      ev("agent.finished", "r1-owner", "r1-s"),
      ev("session.turn_ended", "r1-closer", "r1-other"),
      call("r1-helper", "r1-s", "toolu_r1_a"),
      ...finishers("r1"),
      ev("session.turn_ended", "r1-intruder", "r1-s"),
    ]);
    expect(lastPhase(h, "r1", "r1-helper", "toolu_r1_a")).toBe("unfinished");
    expect(await expectEquivalent(h, "r1")).toEqual([]);
  });

  it("R2: the owner's own tool_call.finished in the other session closes its request", async () => {
    const h = await start();
    h.addProject("r2", SPIKE_CWD);
    ingestAll(h, "r2", "r2", [
      ev("session.started", "r2-owner", "r2-s"),
      ev("session.started", "r2-owner", "r2-other"),
      permission("r2-owner", "r2-other", "r2-req"),
      ev("agent.finished", "r2-owner", "r2-s"),
      done("r2-owner", "r2-other", "toolu_r2_own"),
      call("r2-helper", "r2-s", "toolu_r2_a"),
      ...finishers("r2"),
      ev("session.turn_ended", "r2-intruder", "r2-s"),
    ]);
    expect(lastPhase(h, "r2", "r2-helper", "toolu_r2_a")).toBe("unfinished");
    expect(await expectEquivalent(h, "r2")).toEqual([]);
  });

  it("R3: a running call of the finished owner in another session keeps it", async () => {
    const h = await start();
    h.addProject("r3", SPIKE_CWD);
    ingestAll(h, "r3", "r3", [
      ev("session.started", "r3-owner", "r3-s"),
      ev("agent.finished", "r3-owner", "r3-s"),
      call("r3-owner", "r3-other", "toolu_r3_own"),
      call("r3-helper", "r3-s", "toolu_r3_a"),
      ...finishers("r3"),
      ev("session.turn_ended", "r3-intruder", "r3-s"),
    ]);
    expect(lastPhase(h, "r3", "r3-helper", "toolu_r3_a")).toBe("running");
    expect(await expectEquivalent(h, "r3")).toEqual([]);
  });

  it("R6: a subagent with an open request in another session is kept; its own turn end closes nothing", async () => {
    const h = await start();
    h.addProject("r6", SPIKE_CWD);
    ingestAll(h, "r6", "r6", [
      reg("r6-sub", "r6-s"),
      call("r6-sub", "r6-s", "toolu_r6_sub"),
      permission("r6-sub", "r6-sub-other", "r6-req"),
      ev("agent.finished", "r6-sub", "r6-s"),
      call("r6-helper", "r6-s", "toolu_r6_a"),
      ...finishers("r6"),
      ev("session.turn_ended", "r6-sub", "r6-s"),
    ]);
    expect(lastPhase(h, "r6", "r6-helper", "toolu_r6_a")).toBe("running");
    expect(await expectEquivalent(h, "r6")).toEqual([]);
  });

  it("R5 (live path): frames sent live equal the full fold after an intruder and a helper turn end", async () => {
    const h = await start({ heartbeatMs: 40 });
    h.addProject("r5", SPIKE_CWD);
    ingestAll(h, "r5", "r5", [
      ev("session.started", "r5-owner", "r5-s"),
      ev("session.started", "r5-owner", "r5-other-s"),
      permission("r5-owner", "r5-other-s", "r5-req"),
      ev("agent.finished", "r5-owner", "r5-s"),
      call("r5-helper", "r5-s", "toolu_r5_a"),
      ...finishers("r5"),
    ]);
    const reader: SseReader = await h.openFeed("r5-helper", "?projectId=r5");
    const frames: { id: number; toolCallId: string; phase: string }[] = [];
    const collect = async (count: number): Promise<void> => {
      for (let i = 0; i < 100 && frames.length < count; i++) {
        const frame = await reader.next(5000);
        if (frame === null) return;
        if (frame.event !== "toolcall") continue;
        const d = frame.data as { toolCallId: string; phase: string };
        frames.push({ id: frame.id ?? -1, toolCallId: d.toolCallId, phase: d.phase });
      }
    };
    try {
      await collect(1);
      expect(frames.map((f) => `${f.id}:${f.phase}`)).toEqual(["6:running"]);
      ingestRaw(h, "r5", "r5-live", [
        ev("session.turn_ended", "r5-intruder", "r5-s"),
        ev("session.turn_ended", "r5-helper", "r5-s"),
      ]);
      await collect(2);
      // Settle: a wrongly closing fold would send its extra frame at once.
      await new Promise<void>((r) => setTimeout(r, 300));
      await collect(3);
    } finally {
      await reader.cancel();
    }
    const expected = fullFold(h, "r5", "r5-helper", 0).map((f) => `${f.id}:${f.phase}`);
    expect(expected).toEqual(["6:running", "63:unfinished"]);
    expect(frames.map((f) => `${f.id}:${f.phase}`)).toEqual(expected);
  });
});
