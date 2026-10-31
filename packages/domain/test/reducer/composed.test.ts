import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInputEvent, type StoredEnvelope, storedEnvelopeSchema } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import {
  type EventFixture,
  type ExpectedIngest,
  fixturePath,
  loadFixture,
} from "../../../../fixtures/events/loader.ts";
import { initialState, projectStateHash, reduce, replay } from "../../src/reducer/index.ts";
import { attention } from "../../src/selectors/index.ts";
import { eventStream } from "./events.ts";

// The composed reducer (entities, then M1.08's requests slice) over the M1.17 fixtures, and the
// attention selectors over reducer-built state.

/**
 * Stored envelopes for a fixture, as the engine would store them: project.created at sequence 1,
 * then each accepted line at the sequence its expected.json assigns. The masking step is the
 * engine's (M1.20); these fixtures carry no secrets, so a reason is stored unmasked, and the
 * test checks it fits the 280-character stored limit instead of cutting it.
 */
async function storedFixture(name: EventFixture): Promise<StoredEnvelope[]> {
  const expectedPath = fixturePath(name).replace(/\.jsonl$/, ".expected.json");
  const expected = (await import(expectedPath, { with: { type: "json" } }))
    .default as ExpectedIngest;
  expect(expected.after).toEqual([]);
  const sequenceByLine = new Map(
    expected.results
      .filter((r) => r.status === "accepted")
      .map((r) => [r.line, r.ingestSequence as number]),
  );
  const uuid = (seq: number) => `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
  const projectId = "demo";
  const events: StoredEnvelope[] = [
    storedEnvelopeSchema.parse({
      schemaVersion: 1,
      projectId,
      sourceId: "taskville:engine",
      sourceEventId: "project-created",
      occurredAt: "2026-10-30T09:00:00Z",
      type: "project.created",
      payload: { name: "Demo", roots: ["/repo/demo"], builtin: false },
      evidenceIds: [],
      provenance: "live",
      late: false,
      eventId: uuid(1),
      receivedAt: "2026-10-30T09:00:00Z",
      ingestSequence: 1,
    }),
  ];
  for (const entry of loadFixture(name)) {
    const ingestSequence = sequenceByLine.get(entry.line);
    if (ingestSequence === undefined || !entry.ok) continue;
    const parsed = parseInputEvent(entry.value);
    if (!parsed.ok) throw new Error(`${name}:${entry.line}: ${parsed.error.message}`);
    const payload: Record<string, unknown> = { ...parsed.event.payload };
    if (typeof payload.reason === "string") {
      expect([...payload.reason].length).toBeLessThanOrEqual(280);
      payload.reason = { text: payload.reason, masked: false, truncated: false };
    }
    events.push(
      storedEnvelopeSchema.parse({
        ...parsed.event,
        payload,
        eventId: uuid(ingestSequence),
        receivedAt: parsed.event.occurredAt,
        ingestSequence,
      }),
    );
  }
  expect(events.length).toBe(expected.summary.accepted + 1);
  return events;
}

const snapshotPath = (name: EventFixture): string =>
  join(import.meta.dirname, "snapshots", name.replace(/\.jsonl$/, ".state.json"));

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("composed reducer over the event fixtures", () => {
  for (const name of ["crew.jsonl", "basic-two-agents.jsonl"] as const) {
    it(`${name}: replay gives the same stateHash every time, and from stored JSON`, async () => {
      const events = await storedFixture(name);
      const first = replay("demo", events);
      const second = replay("demo", json(events));
      expect(projectStateHash(second)).toBe(projectStateHash(first));
      const half = Math.floor(events.length / 2);
      const resumed = events
        .slice(half)
        .reduce(reduce, json(replay("demo", events.slice(0, half))));
      expect(projectStateHash(resumed)).toBe(projectStateHash(first));
      expect(first.head).toBe(events.length);
      // The state is pinned in a hand-reviewed file so any rule change shows up in review. To
      // regenerate after a deliberate change: write JSON.stringify(first) to the file, run
      // `biome format --write` on it, review the diff, and bump REDUCER_VERSION.
      const pinned = JSON.parse(readFileSync(snapshotPath(name), "utf8")) as unknown;
      expect(first).toEqual(pinned);
    });
  }

  it("crew.jsonl: subagent parents, the team, and the teammate's request come out as recorded", async () => {
    const state = replay("demo", await storedFixture("crew.jsonl"));
    expect(state.agents.main).toMatchObject({ kind: "lead", teamId: "team-1", registered: true });
    expect(state.agents["sub-1"]).toMatchObject({ kind: "subagent", parentAgentId: "main" });
    expect(state.agents["sub-2"]).toMatchObject({ kind: "subagent", parentAgentId: "sub-1" });
    expect(state.agents["sub-1"]?.finishedAt).toBeDefined();
    expect(state.agents["mate-1"]).toMatchObject({ kind: "teammate", teamId: "team-1" });
    expect(state.agents["mate-1"]?.parentAgentId).toBeUndefined();
    expect(state.teams["team-1"]).toMatchObject({
      leadAgentId: "main",
      memberAgentIds: ["main", "mate-1"],
    });
    expect(state.teams["team-1"]?.endedAt).toBeDefined();
    // The teammate shares the lead's session (S-2) but the session stays the lead's.
    expect(state.sessions["sess-main"]).toMatchObject({ agentId: "main" });
    expect(state.sessions["sess-main"]?.endedAt).toBeDefined();
    expect(state.activity["mate-1"]).toMatchObject({
      activity: "idle",
      openSessionCount: 0,
      latestEvidence: { kind: "test_result", passed: 41, failed: 0, skipped: 2 },
    });
    expect(state.activity.main).toMatchObject({ activity: "idle", openSessionCount: 0 });
    // Telemetry request: never answerable, closed by the teammate's tool result.
    expect(state.requests["req-1"]).toMatchObject({
      agentId: "mate-1",
      answerable: false,
      state: "answered_elsewhere",
    });
    expect(Object.keys(state.toolCalls).sort()).toEqual(["tc-agent-2", "tc-agent-3", "tc-bash-1"]);
  });
});

describe("attention selectors over reducer-built state", () => {
  it("dates a turn record from the turn event (lastTurnAt), not from later activity", () => {
    const emit = eventStream();
    const s = { agentId: "a1", sessionId: "s1" };
    let state = initialState("p1");
    state = reduce(state, emit("session.started", {}, s));
    state = reduce(state, emit("agent.connected", {}, { agentId: "a1" }));
    state = reduce(state, emit("session.turn_ended", {}, s)); // 10:00:03Z
    state = reduce(state, emit("agent.connected", {}, { agentId: "a1" })); // 10:00:04Z
    expect(state.agents.a1).toMatchObject({
      lastTurn: "ended",
      lastTurnAt: "2026-10-30T10:00:03Z",
      lastSeenAt: "2026-10-30T10:00:04Z",
    });
    const records = attention(state, Date.parse("2026-10-30T10:00:05Z"));
    expect(records).toContainEqual(
      expect.objectContaining({ agentId: "a1", kind: "turn_ended", since: "2026-10-30T10:00:03Z" }),
    );
  });

  it("dates a stop_failure record from the failed turn", () => {
    const emit = eventStream();
    const s = { agentId: "a1", sessionId: "s1" };
    let state = initialState("p1");
    state = reduce(state, emit("session.turn_failed", {}, s)); // 10:00:01Z
    state = reduce(state, emit("tool_call.started", { toolCallId: "t", toolName: "Bash" }, s));
    const records = attention(state, Date.parse("2026-10-30T10:00:05Z"));
    expect(records).toContainEqual(
      expect.objectContaining({ kind: "stop_failure", since: "2026-10-30T10:00:01Z" }),
    );
  });
});
