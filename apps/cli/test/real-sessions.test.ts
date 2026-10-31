import { replay } from "@taskville/domain/reducer";
import { attention } from "@taskville/domain/selectors";
import { type StoredEnvelope, storedEnvelopeSchemas } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { renderStatus } from "../src/status.ts";

// M2.13 in `taskville status`: an unfinished tool call (no result recorded, S-1) is shown as
// neither a failure nor a success, and a teammate's ended turn is not "waiting" on you.

const LEAD = "claude-code:s1";
const MATE = "claude-code:s2";

function stream(): (
  type: string,
  payload: object,
  agentId: string,
  sessionId: string,
) => StoredEnvelope {
  let seq = 0;
  return (type, payload, agentId, sessionId) => {
    seq += 1;
    const at = new Date(Date.UTC(2026, 9, 30, 10, 0, seq)).toISOString();
    return storedEnvelopeSchemas[type as StoredEnvelope["type"]].parse({
      schemaVersion: 1,
      projectId: "p1",
      sourceId: "claude-code",
      sourceEventId: `e-${seq}`,
      occurredAt: at,
      type,
      payload,
      agentId,
      sessionId,
      evidenceIds: [],
      provenance: "live",
      late: false,
      eventId: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
      receivedAt: at,
      ingestSequence: seq,
    }) as StoredEnvelope;
  };
}

describe("status with real Claude Code session rules (M2.13)", () => {
  it("shows a lead whose three calls were denied as waiting, never as tool trouble", () => {
    const emit = stream();
    const events: StoredEnvelope[] = [
      emit(
        "agent.registered",
        { sourceAgentId: "s1", displayName: "proj", role: "main", kind: "session" },
        LEAD,
        "s1",
      ),
      emit("session.started", {}, LEAD, "s1"),
    ];
    for (const id of ["t1", "t2", "t3"]) {
      events.push(emit("session.prompt_submitted", {}, LEAD, "s1"));
      events.push(emit("tool_call.started", { toolCallId: id, toolName: "Bash" }, LEAD, "s1"));
      events.push(emit("session.turn_ended", {}, LEAD, "s1"));
    }
    const state = replay("p1", events);
    expect(Object.values(state.toolCalls).map((c) => c.phase)).toEqual(["unfinished"]);
    const out = renderStatus(
      {
        projectId: "p1",
        cursor: state.head,
        stateHash: "x",
        state,
        attention: attention(state, Date.parse("2026-10-30T10:01:00Z")),
      },
      { projectName: "Demo", all: false },
    );
    expect(out).toContain("0 trouble · 1 waiting");
    expect(out).toContain("proj · unknown · unknown · waiting");
    expect(out).not.toContain("trouble:");
  });

  it("does not show a split-pane teammate's ended turn as waiting", () => {
    const emit = stream();
    const state = replay("p1", [
      emit("session.started", {}, MATE, "s2"),
      emit(
        "agent.registered",
        { sourceAgentId: "s2", displayName: "pip", role: "dev", kind: "teammate" },
        MATE,
        "s2",
      ),
      emit("session.turn_ended", {}, MATE, "s2"),
    ]);
    const out = renderStatus(
      {
        projectId: "p1",
        cursor: state.head,
        stateHash: "x",
        state,
        attention: attention(state, Date.parse("2026-10-30T12:00:00Z")),
      },
      { projectName: "Demo", all: false },
    );
    expect(out).toContain("0 waiting");
    expect(out).toMatch(/^pip \(teammate\)/m);
    expect(out).not.toMatch(/pip.*waiting/);
  });
});
