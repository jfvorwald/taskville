import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInputEvent, type StoredEnvelope, storedEnvelopeSchema } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../../fixtures/events/loader.ts";
import { initialState, reduce, replay } from "../../src/reducer/index.ts";
import { attentionCounts } from "../../src/selectors/index.ts";
import { type Emit, type EnvelopeFields, eventStream } from "./events.ts";

// M7.15 (#391): a late (replayed) event keeps its old occurredAt but arrives after live ones. It
// must not close a newer live request, nor regress a session's activity or the agent's last turn
// (ARCHITECTURE.md sections 7.3 and 8.1, invariant 4).

const S = { agentId: "a1", sessionId: "s1" } as const;
const OLDER = "2026-10-30T11:00:00Z";
const OPENED = "2026-10-30T11:05:00Z";
const NEWER = "2026-10-30T11:10:00Z";

const fold = (events: StoredEnvelope[]) => events.reduce(reduce, initialState("p1"));

/** A live session with a live permission request opened at OPENED. */
function withOpenRequest(emit: Emit) {
  return [
    emit("session.started", {}, { ...S, occurredAt: "2026-10-30T10:00:00Z" }),
    emit(
      "request.opened",
      { requestId: "r1", kind: "permission", toolName: "Bash" },
      { ...S, occurredAt: OPENED },
    ),
  ];
}

const lateEvents: Array<[string, (emit: Emit, f: EnvelopeFields) => StoredEnvelope]> = [
  [
    "tool_call.finished",
    (emit, f) => emit("tool_call.finished", { toolCallId: "t1", phase: "succeeded" }, f),
  ],
  ["session.turn_ended", (emit, f) => emit("session.turn_ended", {}, f)],
  ["session.prompt_submitted", (emit, f) => emit("session.prompt_submitted", {}, f)],
  ["session.ended", (emit, f) => emit("session.ended", {}, f)],
];

describe("a late event against an open request", () => {
  it.each(lateEvents)("late %s older than openedAt leaves the request open", (_, make) => {
    const emit = eventStream();
    const state = fold([
      ...withOpenRequest(emit),
      make(emit, { ...S, late: true, occurredAt: OLDER }),
    ]);
    expect(state.requests.r1?.state).toBe("open");
    expect(attentionCounts(state, Date.parse("2026-10-30T12:00:00Z")).needsYou).toBe(1);
  });

  it.each(lateEvents)("late %s newer than openedAt still closes it", (_, make) => {
    const emit = eventStream();
    const state = fold([
      ...withOpenRequest(emit),
      make(emit, { ...S, late: true, occurredAt: NEWER }),
    ]);
    expect(state.requests.r1?.state).toBe("answered_elsewhere");
  });

  it.each(lateEvents)("live %s closes it as today", (_, make) => {
    const emit = eventStream();
    const state = fold([...withOpenRequest(emit), make(emit, { ...S, occurredAt: OLDER })]);
    expect(state.requests.r1?.state).toBe("answered_elsewhere");
  });
});

describe("a late event against live session state", () => {
  it("does not regress session activity or since", () => {
    const emit = eventStream();
    const live = fold([
      emit("session.started", {}, { ...S, occurredAt: "2026-10-30T10:00:00Z" }),
      emit("activity.started", { activity: "testing" }, { ...S, occurredAt: OPENED }),
    ]);
    const before = live.sessions.s1?.activity;
    expect(before).toMatchObject({ activity: "testing", since: OPENED });
    const after = reduce(
      live,
      emit(
        "activity.started",
        { activity: "researching" },
        { ...S, late: true, occurredAt: OLDER },
      ),
    );
    expect(after.sessions.s1?.activity).toEqual(before);
  });

  it("does not regress the agent's last turn", () => {
    const emit = eventStream();
    const live = fold([
      emit("session.started", {}, { ...S, occurredAt: "2026-10-30T10:00:00Z" }),
      emit("session.turn_ended", {}, { ...S, occurredAt: OPENED }),
    ]);
    expect(live.agents.a1).toMatchObject({ lastTurn: "ended", lastTurnAt: OPENED });
    const failed = reduce(
      live,
      emit("session.turn_failed", {}, { ...S, late: true, occurredAt: OLDER }),
    );
    expect(failed.agents.a1).toMatchObject({ lastTurn: "ended", lastTurnAt: OPENED });
    const prompted = reduce(
      live,
      emit("session.prompt_submitted", {}, { ...S, late: true, occurredAt: OLDER }),
    );
    expect(prompted.agents.a1).toMatchObject({ lastTurn: "ended", lastTurnAt: OPENED });
  });
});

describe("history replay guard", () => {
  it("crew.jsonl with no late events replays to the pinned state", () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
    const events: StoredEnvelope[] = [];
    let seq = 0;
    for (const entry of loadFixture("crew.jsonl")) {
      if (!entry.ok) continue;
      const parsed = parseInputEvent(entry.value);
      if (!parsed.ok) continue;
      seq += 1;
      const payload: Record<string, unknown> = { ...parsed.event.payload };
      if (typeof payload.reason === "string") {
        payload.reason = { text: payload.reason, masked: false, truncated: false };
      }
      events.push(
        storedEnvelopeSchema.parse({
          ...parsed.event,
          payload,
          eventId: uuid(seq + 1),
          receivedAt: parsed.event.occurredAt,
          ingestSequence: seq + 1,
        }),
      );
    }
    const first = storedEnvelopeSchema.parse({
      schemaVersion: 1,
      projectId: "demo",
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
    });
    const pinned = JSON.parse(
      readFileSync(join(import.meta.dirname, "snapshots", "crew.state.json"), "utf8"),
    ) as unknown;
    expect(replay("demo", [first, ...events])).toEqual(pinned);
  });
});
