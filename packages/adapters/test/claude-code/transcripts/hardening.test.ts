import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscriptMapper } from "../../../src/claude-code/transcripts/index.ts";
import { assistantToolUse, T, toolResult, userPrompt } from "./fixtures.ts";

// M8.10 (issue #473, M8.02 security confirm review findings L2 to L6), mapper side.
// The redact module is wrapped (behavior unchanged) for two seams: `redactJson` records the node
// count of every value it is handed, and throws when a value carries the marker key `__boom`
// (an unexpected error after the session was recorded). No credential-shaped data is used.

const seam = vi.hoisted(() => ({ maxNodes: 0 }));

vi.mock("../../../src/redact/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/redact/index.ts")>();
  const count = (value: unknown): number => {
    let n = 0;
    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const v = stack.pop();
      n += 1;
      // Pushed one by one: spreading a million items would overflow the call stack.
      if (v !== null && typeof v === "object") {
        for (const child of Object.values(v)) stack.push(child);
      }
    }
    return n;
  };
  return {
    ...actual,
    redactJson: ((value: Parameters<typeof actual.redactJson>[0]) => {
      seam.maxNodes = Math.max(seam.maxNodes, count(value));
      if (typeof value === "object" && value !== null && "__boom" in value) {
        throw new Error("simulated redaction failure");
      }
      return actual.redactJson(value);
    }) as typeof actual.redactJson,
  };
});

beforeEach(() => {
  seam.maxNodes = 0;
});

const mapper = () => createTranscriptMapper({ projectId: "proj-1" });
const types = (events: { type: string }[]) => events.map((e) => e.type);

describe("item 2: per-line cost is bounded", () => {
  // Required: a cap on nodes per line. No more than 100_000 nodes may reach redactJson, and a
  // line over the cap is truncated with a recorded `reason` string (or skipped with no evidence).
  const TINY = 1_000_000;
  const tiny = () => Array.from({ length: TINY }, () => "a");

  it("caps the nodes of a tool input made of millions of tiny strings", () => {
    const line = assistantToolUse("toolu_1", "Bash", { items: tiny() }, { ts: T(0) });
    const result = mapper().mapLine(JSON.stringify(line), 1);
    expect(seam.maxNodes).toBeLessThanOrEqual(100_000);
    const input = result.evidence?.find((e) => e.input !== undefined)?.input as
      | { truncated?: boolean; reason?: unknown }
      | undefined;
    if (input !== undefined) {
      expect(input.truncated).toBe(true);
      expect(typeof input.reason).toBe("string");
    }
  });

  it("caps the nodes of a tool result made of millions of tiny strings", () => {
    const m = mapper();
    m.mapLine(JSON.stringify(assistantToolUse("toolu_1", "Bash", {}, { ts: T(0) })), 1);
    seam.maxNodes = 0;
    const line = toolResult("toolu_1", tiny(), { ts: T(1) });
    const result = m.mapLine(JSON.stringify(line), 2);
    expect(seam.maxNodes).toBeLessThanOrEqual(100_000);
    const output = result.evidence?.find((e) => e.output !== undefined)?.output as
      | { truncated?: boolean; reason?: unknown }
      | undefined;
    if (output !== undefined) {
      expect(output.truncated).toBe(true);
      expect(typeof output.reason).toBe("string");
    }
  });
});

describe("item 3: mapper state is capped", () => {
  // Required: pending and sessions each hold at most 50_000 entries. Whether a full map evicts
  // the oldest entry or refuses the newest is open: the test only needs that not everything
  // stays remembered. Observable: a forgotten tool call's result lands on the result line's own
  // agent, and a forgotten session registers again.
  const N = 60_000;

  it("does not remember more than 50_000 pending tool calls", () => {
    const m = mapper();
    const sub = { sidechain: true, agentId: "agent-sub" };
    // First and last starts both belong to the subagent; the others to the main agent.
    m.mapLine(JSON.stringify(assistantToolUse("toolu_first", "Read", {}, { ts: T(0), ...sub })), 1);
    for (let i = 0; i < N; i += 1) {
      const id = `toolu_${i}`;
      m.mapLine(JSON.stringify(assistantToolUse(id, "Read", {}, { ts: T(1) })), i + 2);
    }
    m.mapLine(
      JSON.stringify(assistantToolUse("toolu_last", "Read", {}, { ts: T(2), ...sub })),
      N + 2,
    );
    const owners = ["toolu_first", "toolu_last"].map((id, k) => {
      const r = m.mapLine(JSON.stringify(toolResult(id, "ok", { ts: T(3) })), N + 3 + k);
      return r.events.find((e) => e.type === "tool_call.finished")?.agentId;
    });
    // Unbounded state keeps both on the subagent; a cap loses at least one of them.
    expect(new Set(owners).size).toBe(2);
  }, 60_000);

  it("does not remember more than 50_000 sessions", () => {
    const m = mapper();
    const ids = Array.from({ length: N }, (_, i) => `s${i}`);
    ids.forEach((sessionId, i) => {
      m.mapLine(JSON.stringify(userPrompt("hi", { ts: T(0), sessionId })), i + 1);
    });
    const registered = [`s0`, `s${N - 1}`].map((sessionId, k) => {
      const r = m.mapLine(JSON.stringify(userPrompt("again", { ts: T(1), sessionId })), N + 1 + k);
      return types(r.events).includes("agent.registered");
    });
    // Unbounded state registers neither again; a cap forgets at least one of the two.
    expect(registered).toContain(true);
  }, 60_000);
});

describe("item 4: the spawns map and pending map are scoped by session", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const SHARED_UUID = "00000000-0000-4000-8000-0000000000bb";

  it("does not link a subagent to another session's spawn line with the same uuid", () => {
    const m = mapper();
    m.mapLine(
      JSON.stringify(
        assistantToolUse("toolu_AG", "Agent", {}, { ts: T(0), sessionId: A, uuid: SHARED_UUID }),
      ),
      1,
    );
    // Session B has no spawn line; its subagent merely names the same parent uuid.
    const r = m.mapLine(
      JSON.stringify(
        assistantToolUse(
          "toolu_SUB",
          "Read",
          {},
          {
            ts: T(1),
            sessionId: B,
            sidechain: true,
            agentId: "agent-sub",
            parentUuid: SHARED_UUID,
          },
        ),
      ),
      2,
    );
    const sub = r.events.find(
      (e) => e.type === "agent.registered" && (e.payload as { kind?: string }).kind === "subagent",
    );
    expect(sub).toBeDefined();
    expect(sub?.payload).not.toHaveProperty("parentAgentId");
  });

  it("keeps each session's own spawn when two spawn lines share a uuid", () => {
    const m = mapper();
    for (const [i, sessionId] of [A, B].entries()) {
      m.mapLine(
        JSON.stringify(
          assistantToolUse(`toolu_AG${i}`, "Agent", {}, { ts: T(i), sessionId, uuid: SHARED_UUID }),
        ),
        i + 1,
      );
    }
    const r = m.mapLine(
      JSON.stringify(
        assistantToolUse(
          "toolu_SUB",
          "Read",
          {},
          {
            ts: T(5),
            sessionId: A,
            sidechain: true,
            agentId: "agent-sub",
            parentUuid: SHARED_UUID,
          },
        ),
      ),
      3,
    );
    const sub = r.events.find(
      (e) => e.type === "agent.registered" && (e.payload as { kind?: string }).kind === "subagent",
    );
    const mainOfA = m
      .mapLine(JSON.stringify(userPrompt("x", { ts: T(6), sessionId: A })), 4)
      .events.find((e) => e.type === "session.prompt_submitted")?.agentId;
    expect((sub?.payload as { parentAgentId?: string } | undefined)?.parentAgentId).toBe(mainOfA);
  });

  it("does not pair a result with another session's tool call of the same id", () => {
    const m = mapper();
    const started = [A, B].map((sessionId, i) => {
      const r = m.mapLine(
        JSON.stringify(
          assistantToolUse(
            "toolu_SAME",
            "Bash",
            {},
            { ts: T(i), sessionId, sidechain: true, agentId: `agent-${i}` },
          ),
        ),
        i + 1,
      );
      return r.events.find((e) => e.type === "tool_call.started")?.agentId;
    });
    const r = m.mapLine(
      JSON.stringify(
        toolResult("toolu_SAME", "ok", {
          ts: T(5),
          sessionId: A,
          sidechain: true,
          agentId: "agent-0",
        }),
      ),
      3,
    );
    const finished = r.events.find((e) => e.type === "tool_call.finished");
    expect(finished?.agentId).toBe(started[0]);
    expect(finished?.agentId).not.toBe(started[1]);
  });
});

describe("item 5: a registration is not lost when a line throws", () => {
  it("emits the new session's registration on the next line", () => {
    const m = mapper();
    // Redaction fails after the session was recorded and its registration built.
    const bad = m.mapLine(
      JSON.stringify(assistantToolUse("toolu_1", "Bash", { __boom: true }, { ts: T(0) })),
      1,
    );
    expect(bad.outcome).toBe("malformed");
    const next = m.mapLine(JSON.stringify(userPrompt("hello", { ts: T(1) })), 2);
    expect(types(next.events)).toEqual([
      "agent.registered",
      "session.started",
      "session.prompt_submitted",
    ]);
  });
});
