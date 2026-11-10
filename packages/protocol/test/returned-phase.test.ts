import { describe, expect, it } from "vitest";
import {
  parseInputEvent,
  storedEnvelopeSchema,
  TOOL_CALL_FINISH_PHASES,
  TOOL_CALL_PHASES,
} from "../src/index.ts";
import { storedFrom, wireEvent } from "./fixtures.ts";

// A1.00: a tool call can finish with phase `returned` (the call came back, its outcome was not
// reported). Constitution IV: it must not be recorded as succeeded or failed.

const finished = (phase: string) => ({ toolCallId: "tc-1", phase });

describe("tool_call.finished phase returned", () => {
  it("lists returned among the finish phases and the call phases", () => {
    expect([...TOOL_CALL_FINISH_PHASES]).toEqual(["succeeded", "failed", "returned"]);
    expect([...TOOL_CALL_PHASES]).toEqual(["running", "succeeded", "failed", "returned"]);
  });

  it.each(["succeeded", "failed", "returned"])("input schema accepts phase %s", (phase) => {
    const result = parseInputEvent(wireEvent("tool_call.finished", finished(phase)));
    expect(result.ok).toBe(true);
    if (result.ok && result.event.type === "tool_call.finished") {
      expect(result.event.payload.phase).toBe(phase);
    }
  });

  it.each(["succeeded", "failed", "returned"])("stored schema accepts phase %s", (phase) => {
    const parsed = parseInputEvent(wireEvent("tool_call.finished", finished("succeeded")));
    if (!parsed.ok) throw new Error("fixture is invalid");
    const stored = storedFrom(wireEvent("tool_call.finished", finished(phase), { late: false }));
    const result = storedEnvelopeSchema.safeParse({ ...stored, evidenceIds: [] });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "tool_call.finished") {
      expect(result.data.payload.phase).toBe(phase);
    }
  });

  it.each(["crashed", "running", "Returned", ""])("still rejects phase %j", (phase) => {
    const result = parseInputEvent(wireEvent("tool_call.finished", finished(phase)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("payload.phase");
  });
});
