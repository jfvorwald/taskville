import type { SSEStreamingApi } from "hono/streaming";
import { afterEach, describe, expect, it } from "vitest";
import { FeedSubscriber } from "../../src/feed/subscriber.ts";
import { ToolCallTracker } from "../../src/feed/tool-calls.ts";
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
