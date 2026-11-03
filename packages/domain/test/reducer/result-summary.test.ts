import { REASON_MAX_CHARS } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { replay } from "../../src/reducer/index.ts";
import { eventStream } from "./events.ts";

// M5.25 red (decision #333 D1): `agent.finished` carries an optional `summary`; the reducer keeps
// it on the Agent as `resultSummary`, redacted and capped so the store never holds an unbounded or
// secret-bearing string. Cap: REASON_MAX_CHARS (280) Unicode code points. Redaction: the adapters'
// `redactText` rule (a recognised token becomes a `[REDACTED:<kind>]` marker).

const CAP = REASON_MAX_CHARS;

function finishedWith(payload: { outcome?: string; summary?: string }) {
  const emit = eventStream();
  return replay("p1", [
    emit(
      "agent.registered",
      { sourceAgentId: "src-a1", displayName: "a1", role: "dev", kind: "subagent" },
      { agentId: "a1" },
    ),
    emit("agent.connected", {}, { agentId: "a1" }),
    emit("agent.finished", payload, { agentId: "a1" }),
  ]);
}

describe("agent.finished result summary (M5.25)", () => {
  it("sets resultSummary from the finished summary", () => {
    const state = finishedWith({ summary: "Fixed the flaky parser test." });
    expect(state.agents.a1?.resultSummary).toBe("Fixed the flaky parser test.");
    expect(state.agents.a1?.finishedAt).toBeDefined();
  });

  it("leaves resultSummary absent when the event has no summary", () => {
    const state = finishedWith({ outcome: "done" });
    expect(state.agents.a1).toBeDefined();
    expect(Object.hasOwn(state.agents.a1 ?? {}, "resultSummary")).toBe(false);
  });

  it("leaves resultSummary absent for an empty summary", () => {
    const state = finishedWith({ summary: "" });
    expect(Object.hasOwn(state.agents.a1 ?? {}, "resultSummary")).toBe(false);
  });

  it("redacts a secret-looking token in the summary", () => {
    const token = `ghp_${"aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5".slice(0, 36)}`;
    const state = finishedWith({ summary: `Deployed using ${token} as the credential.` });
    const summary = state.agents.a1?.resultSummary;
    expect(summary).toBeDefined();
    expect(summary).not.toContain(token);
    expect(summary).toContain("[REDACTED:");
    expect(summary).toContain("Deployed using");
  });

  it("caps an over-long summary at the code point limit", () => {
    const long = "x".repeat(CAP * 5);
    const summary = finishedWith({ summary: long }).agents.a1?.resultSummary;
    expect(summary).toBeDefined();
    expect([...(summary ?? "")].length).toBeLessThanOrEqual(CAP);
    expect(summary?.startsWith("x".repeat(CAP - 10))).toBe(true);
  });

  it("keeps a summary exactly at the cap whole", () => {
    const exact = "y".repeat(CAP);
    expect(finishedWith({ summary: exact }).agents.a1?.resultSummary).toBe(exact);
  });
});
