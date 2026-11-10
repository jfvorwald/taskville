import type { InputEvent } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { normalizePayload } from "../../src/ingest/normalize.ts";

// roborev 7898: a high-entropy toolCallId without a recognized Claude prefix must
// survive masking on team.message, as it does on tool_call.started, so the envelope
// click can find the matching Live card.
const HIGH_ENTROPY_ID = "k8Zq3Rm7Xv2Lp9Wd4Ns6Bt1Hy5Jc0GfQaUeOiTr";

function event(type: string, payload: Record<string, unknown>): InputEvent {
  return { type, payload } as unknown as InputEvent;
}

describe("normalizePayload toolCallId (roborev 7898)", () => {
  it("masks the value in a free-text field, so the id is a real masking case", () => {
    const { hashed } = normalizePayload(event("team.message", { note: HIGH_ENTROPY_ID }));
    expect(hashed.note).not.toBe(HIGH_ENTROPY_ID);
  });

  it("keeps toolCallId unchanged on tool_call.started (control)", () => {
    const { hashed, stored } = normalizePayload(
      event("tool_call.started", { toolCallId: HIGH_ENTROPY_ID }),
    );
    expect(hashed.toolCallId).toBe(HIGH_ENTROPY_ID);
    expect(stored.toolCallId).toBe(HIGH_ENTROPY_ID);
  });

  it("keeps toolCallId unchanged on team.message", () => {
    const { hashed, stored } = normalizePayload(
      event("team.message", { kind: "message", toolCallId: HIGH_ENTROPY_ID }),
    );
    expect(hashed.toolCallId).toBe(HIGH_ENTROPY_ID);
    expect(stored.toolCallId).toBe(HIGH_ENTROPY_ID);
  });
});
