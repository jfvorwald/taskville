import { describe, expect, it } from "vitest";
import type { SseReader } from "../stream/helpers.ts";
import { ingestRaw, SPIKE_CWD, type ToolCallFrame, useHarness } from "./helpers.ts";
import { countRows } from "./subset-rows.ts";

// M5.14 (#281): an index of events by agent, so a feed open, a crew request and agent-to-project
// resolution read the events of that agent and not the project's whole log. Work is COUNTED, never
// timed (L-206): the rows the storage layer hands back from the events table while the request
// runs. The counter wraps `StatementSync.prototype` (iterate, all, get) and counts the rows of
// every statement that reads event envelopes, so it holds for any index design (a side table, a
// join, a per-row lookup) and for any storage method name the implementation picks.
//
// The bound is a multiple of the agent's own events plus a small slack for events a design must
// also read to keep results identical (a registration, a session boundary of the same session).
// The noise is far above it: NOISE_EVENTS events of other agents, each in its own session.

const start = useHarness();
const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const at = (i: number) => new Date(T0 + i * 1000).toISOString();
const NOISE_AGENTS = 8;
const NOISE_PER_AGENT = 60;
const NOISE_EVENTS = NOISE_AGENTS * NOISE_PER_AGENT;
/** Generous for an indexed read of a handful of events; the unindexed read is 480+. */
const BOUND = 40;

type H = Awaited<ReturnType<typeof start>>;

const countEventRows = countRows;

/** Ingests in batches, so no single call is large. */
function ingestMany(h: H, label: string, events: Parameters<typeof ingestRaw>[3]): void {
  for (let i = 0; i < events.length; i += 40) {
    ingestRaw(h, "spike", `${label}-${i}`, events.slice(i, i + 40));
  }
}

/** Events of other agents, each agent in its own session, interleaved with the target's. */
function noise(h: H, from: number, tag: string): void {
  const events: Parameters<typeof ingestRaw>[3] = [];
  for (let n = 0; n < NOISE_PER_AGENT; n++) {
    for (let a = 0; a < NOISE_AGENTS; a++) {
      events.push({
        type: "tool_call.started",
        agentId: `idx-noise-${a}`,
        sessionId: `idx-noise-session-${a}`,
        at: at(from + n * NOISE_AGENTS + a),
        payload: { toolCallId: `noise-${tag}-${a}-${n}`, toolName: "Bash" },
      });
    }
  }
  ingestMany(h, `idx-noise-${tag}`, events);
}

const TARGET = "idx-target";
const TARGET_SESSION = "idx-target-session";

/** The target's own events: a finished call, then a running one. Noise comes before and after. */
function seedFeed(h: H): void {
  h.addProject("spike", SPIKE_CWD);
  noise(h, 1000, "a");
  ingestRaw(h, "spike", "idx-target-1", [
    {
      type: "tool_call.started",
      agentId: TARGET,
      sessionId: TARGET_SESSION,
      at: at(0),
      payload: { toolCallId: "toolu_idx_1", toolName: "Read" },
    },
    {
      type: "tool_call.finished",
      agentId: TARGET,
      sessionId: TARGET_SESSION,
      at: at(1),
      payload: { toolCallId: "toolu_idx_1", phase: "succeeded" },
    },
  ]);
  noise(h, 2000, "b");
  ingestRaw(h, "spike", "idx-target-2", [
    {
      type: "tool_call.started",
      agentId: TARGET,
      sessionId: TARGET_SESSION,
      at: at(2),
      payload: { toolCallId: "toolu_idx_2", toolName: "Bash" },
    },
  ]);
}

/** Reads toolcall frames until the feed says it has caught up (a heartbeat). */
async function toCaughtUp(reader: SseReader): Promise<{ id: number; data: ToolCallFrame }[]> {
  const out: { id: number; data: ToolCallFrame }[] = [];
  for (;;) {
    const frame = await reader.next(5000);
    if (frame === null) throw new Error("feed ended before it caught up");
    if (frame.event === "heartbeat") return out;
    if (frame.event === "toolcall") {
      out.push({ id: frame.id ?? -1, data: frame.data as ToolCallFrame });
    }
  }
}

describe("feed open reads only the agent's own events", () => {
  it("serves the same frames, reading a bounded number of event rows however much other agents logged", async () => {
    const h = await start();
    seedFeed(h);
    const head = h.engine.storage.head("spike") ?? 0;
    expect(head).toBeGreaterThanOrEqual(2 * NOISE_EVENTS);

    let frames: { id: number; data: ToolCallFrame }[] = [];
    const rows = await countEventRows(async () => {
      const reader = await h.openFeed(TARGET);
      frames = await toCaughtUp(reader);
      await reader.cancel();
    });

    // Identical to reading the whole log: ids are the ingest sequences of the target's events.
    expect(frames.map((f) => [f.data.toolCallId, f.data.phase])).toEqual([
      ["toolu_idx_1", "running"],
      ["toolu_idx_1", "succeeded"],
      ["toolu_idx_2", "running"],
    ]);
    expect(frames.every((f) => f.id >= 1 && f.id <= head)).toBe(true);
    expect(new Set(frames.map((f) => f.id)).size).toBe(3);
    // Fails now: the feed folds all of the project's events (about 1,000 rows).
    expect(rows).toBeLessThanOrEqual(BOUND);
  });

  it("resumes from ?after= with the same frames and the same bounded read", async () => {
    const h = await start();
    seedFeed(h);
    const full = await h.openFeed(TARGET);
    const all = await toCaughtUp(full);
    await full.cancel();
    const cursor = all[1]?.id ?? 0;

    let frames: { id: number; data: ToolCallFrame }[] = [];
    const rows = await countEventRows(async () => {
      const reader = await h.openFeed(TARGET, `?after=${cursor}`);
      frames = await toCaughtUp(reader);
      await reader.cancel();
    });
    expect(frames.map((f) => [f.data.toolCallId, f.data.phase])).toEqual([
      ["toolu_idx_2", "running"],
    ]);
    expect(rows).toBeLessThanOrEqual(BOUND);
  });
});

describe("agent-to-project resolution reads no log for an agent no project holds", () => {
  // A negative lookup must be O(1) in history (the M1 medium from the M5.01 security review):
  // `/feed` or `/crew` for a random ID without ?projectId= must not scan any project's log.
  const UNKNOWN_ROWS = 5;

  it.each([
    ["feed", "feed"],
    ["crew", "crew"],
  ] as const)(
    "answers 404 unknown_agent on %s with only a constant number of reads",
    async (_n, route) => {
      const h = await start();
      seedFeed(h);
      let status = 0;
      let code: unknown;
      const rows = await countEventRows(async () => {
        const res = await h.get(`/v1/agents/never-seen/${route}`);
        status = res.status;
        code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      });
      expect(status).toBe(404);
      expect(code).toBe("unknown_agent");
      // Fails now: every project's log is read to the end to settle the "no".
      expect(rows).toBeLessThanOrEqual(UNKNOWN_ROWS);
    },
  );

  it("also with ?projectId= naming a project that holds other agents only", async () => {
    const h = await start();
    seedFeed(h);
    let status = 0;
    const rows = await countEventRows(async () => {
      status = (await h.get("/v1/agents/never-seen/crew?projectId=spike")).status;
    });
    expect(status).toBe(404);
    expect(rows).toBeLessThanOrEqual(UNKNOWN_ROWS);
  });

  it("still finds the project of a known agent and still answers 409 for an agent in two projects", async () => {
    // Guard: the index must not change resolution results.
    const h = await start();
    seedFeed(h);
    h.addProject("other", "/tmp/other-root");
    ingestRaw(h, "other", "idx-dup", [
      {
        type: "tool_call.started",
        agentId: TARGET,
        sessionId: "idx-other-session",
        at: at(3),
        payload: { toolCallId: "toolu_idx_other", toolName: "Read" },
      },
    ]);
    const ambiguous = await h.crew(TARGET);
    expect(ambiguous.status).toBe(409);
    const named = await h.crew(TARGET, "?projectId=spike");
    expect(named.status).toBe(200);
    expect(((await named.json()) as { projectId: string }).projectId).toBe("spike");
    const solo = await h.crew("idx-noise-3");
    expect(solo.status).toBe(200);
  });
});

describe("crew reads only the events of the agent's crew", () => {
  it("returns the same crew, reading a bounded number of event rows", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    noise(h, 1000, "a");
    ingestRaw(h, "spike", "idx-crew", [
      {
        type: "agent.registered",
        agentId: "idx-lead",
        sessionId: "idx-lead-session",
        at: at(0),
        payload: { sourceAgentId: "idx-lead", displayName: "lead", role: "lead", kind: "lead" },
      },
      {
        type: "agent.registered",
        agentId: "idx-sub",
        sessionId: "idx-lead-session",
        at: at(1),
        payload: {
          sourceAgentId: "idx-sub",
          displayName: "sub",
          role: "researcher",
          kind: "subagent",
          parentAgentId: "idx-lead",
        },
      },
      {
        type: "agent.finished",
        agentId: "idx-sub",
        sessionId: "idx-lead-session",
        at: at(2),
        payload: { summary: "found the answer" },
      },
    ]);
    noise(h, 2000, "b");

    let body: { subagents: { agentId: string; status: string; resultSummary?: string }[] } = {
      subagents: [],
    };
    let status = 0;
    const rows = await countEventRows(async () => {
      const res = await h.crew("idx-lead");
      status = res.status;
      body = (await res.json()) as typeof body;
    });
    expect(status).toBe(200);
    expect(body.subagents).toMatchObject([
      { agentId: "idx-sub", status: "finished", resultSummary: "found the answer" },
    ]);
    // Fails now: the crew pass reads the whole log to collect finish summaries.
    expect(rows).toBeLessThanOrEqual(BOUND);
  });
});
