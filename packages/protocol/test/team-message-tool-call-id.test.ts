import { describe, expect, it } from "vitest";
import { parseInputEvent } from "../src/index.ts";
import { wireEvent } from "./fixtures.ts";

// M5.28 (decision #556): team.message may carry the SendMessage tool-call id, so the Live feed
// can focus the exact card. Additive: events without it still parse.

const parse = (payload: Record<string, unknown>) =>
  parseInputEvent(wireEvent("team.message", payload));

describe("team.message toolCallId", () => {
  it("accepts an optional toolCallId string and keeps it", () => {
    const result = parse({ to: "bo", kind: "message", toolCallId: "toolu_01PJ4G9W" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.event.payload).toMatchObject({ toolCallId: "toolu_01PJ4G9W" });
  });

  it("still accepts a payload without toolCallId", () => {
    const result = parse({ to: "bo", kind: "message", summary: "hi" });
    expect(result.ok).toBe(true);
  });

  it("rejects a toolCallId that is not a string", () => {
    const result = parse({ to: "bo", kind: "message", toolCallId: 7 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("payload.toolCallId");
  });
});
