import { describe, expect, it } from "vitest";
import {
  ENGINE_ONLY_EVENT_TYPES,
  EVENT_TYPES,
  INPUT_PREVIEW_MAX_CHARS,
  INPUT_REASON_MAX_CHARS,
  ingestResultSchema,
  isEngineOnlyEventType,
  parseInputEvent,
  producerPolicyViolation,
  REASON_MAX_CHARS,
  REJECTION_CODES,
  RESERVED_SOURCE_PREFIX,
  storedReasonSchema,
} from "../src/index.ts";
import { validPayloads, wireEvent } from "./fixtures.ts";

const parsed = (type: (typeof EVENT_TYPES)[number], overrides: Record<string, unknown> = {}) => {
  const result = parseInputEvent(wireEvent(type, validPayloads[type], overrides));
  if (!result.ok) throw new Error(`fixture for ${type} invalid: ${result.error.message}`);
  return result.event;
};

describe("rejection codes", () => {
  it("are exactly the codes in events.md", () => {
    expect([...REJECTION_CODES].sort()).toEqual(
      [
        "unsupported_schema_version",
        "unknown_type",
        "invalid_envelope",
        "invalid_payload",
        "unknown_project",
        "provenance_mismatch",
        "engine_only_type",
        "reserved_source",
      ].sort(),
    );
  });
});

describe("producer policy (batch route)", () => {
  it.each(ENGINE_ONLY_EVENT_TYPES)("rejects engine-only %s with engine_only_type", (type) => {
    expect(isEngineOnlyEventType(type)).toBe(true);
    expect(producerPolicyViolation(parsed(type))?.code).toBe("engine_only_type");
  });

  it.each(EVENT_TYPES.filter((t) => !isEngineOnlyEventType(t)))(
    "lets a producer send %s",
    (type) => {
      expect(producerPolicyViolation(parsed(type))).toBeUndefined();
    },
  );

  it("rejects the reserved taskville: source prefix with reserved_source", () => {
    expect(RESERVED_SOURCE_PREFIX).toBe("taskville:");
    const event = parsed("agent.connected", { sourceId: "taskville:bridge" });
    expect(producerPolicyViolation(event)?.code).toBe("reserved_source");
    expect(producerPolicyViolation(event)?.path).toBe("sourceId");
  });

  it("does not treat a source that merely contains taskville as reserved", () => {
    const event = parsed("agent.connected", { sourceId: "adapter:taskville:x" });
    expect(producerPolicyViolation(event)).toBeUndefined();
  });

  it("requires demo provenance for demo: sources and vice versa", () => {
    expect(
      producerPolicyViolation(
        parsed("agent.connected", { sourceId: "demo:42", provenance: "live" }),
      )?.code,
    ).toBe("provenance_mismatch");
    expect(
      producerPolicyViolation(parsed("agent.connected", { sourceId: "cli", provenance: "demo" }))
        ?.code,
    ).toBe("provenance_mismatch");
    expect(
      producerPolicyViolation(
        parsed("agent.connected", { sourceId: "demo:42", provenance: "demo" }),
      ),
    ).toBeUndefined();
  });
});

describe("reason limits (FR-017)", () => {
  const turnFailed = (reason: string) =>
    parseInputEvent(wireEvent("session.turn_failed", { reason }));

  it("accepts an input reason up to 4,000 characters and rejects one longer", () => {
    expect(INPUT_REASON_MAX_CHARS).toBe(4000);
    expect(turnFailed("r".repeat(4000)).ok).toBe(true);
    const tooLong = turnFailed("r".repeat(4001));
    expect(!tooLong.ok && tooLong.error.code).toBe("invalid_payload");
  });

  it("counts characters as code points, not UTF-16 units", () => {
    expect(turnFailed("\u{1F600}".repeat(4000)).ok).toBe(true);
    expect(
      storedReasonSchema.safeParse({
        text: "\u{1F600}".repeat(280),
        masked: false,
        truncated: false,
      }).success,
    ).toBe(true);
  });

  it("stores a reason as { text, masked, truncated } of at most 280 characters", () => {
    expect(REASON_MAX_CHARS).toBe(280);
    const ok = { text: "t".repeat(280), masked: true, truncated: true };
    expect(storedReasonSchema.parse(ok)).toEqual(ok);
    expect(storedReasonSchema.safeParse({ ...ok, text: "t".repeat(281) }).success).toBe(false);
    expect(storedReasonSchema.safeParse({ text: "t", masked: true }).success).toBe(false);
    expect(storedReasonSchema.safeParse({ text: "t", truncated: false }).success).toBe(false);
    expect(storedReasonSchema.safeParse("plain string").success).toBe(false);
  });

  it("limits inputPreview to 2,000 characters", () => {
    expect(INPUT_PREVIEW_MAX_CHARS).toBe(2000);
    const opened = (inputPreview: string) =>
      parseInputEvent(wireEvent("request.opened", { requestId: "r", kind: "input", inputPreview }));
    expect(opened("p".repeat(2000)).ok).toBe(true);
    const tooLong = opened("p".repeat(2001));
    expect(!tooLong.ok && tooLong.error.path).toBe("payload.inputPreview");
  });
});

describe("ingest result", () => {
  it.each([
    {
      sourceEventId: "e-17",
      status: "accepted",
      ingestSequence: 42,
      eventId: "0b6c2d8e-6a0f-4f7e-9c1d-2f4b8a6e3c10",
    },
    {
      sourceEventId: "e-17",
      status: "duplicate",
      ingestSequence: 42,
      eventId: "0b6c2d8e-6a0f-4f7e-9c1d-2f4b8a6e3c10",
    },
    {
      sourceEventId: "e-18",
      status: "conflict",
      existingEventId: "0b6c2d8e-6a0f-4f7e-9c1d-2f4b8a6e3c10",
    },
    {
      sourceEventId: "e-19",
      status: "rejected",
      error: { code: "invalid_payload", path: "payload.status", message: "bad" },
    },
    {
      sourceEventId: "e-20",
      status: "rejected",
      error: { code: "unknown_project", message: "no such project" },
    },
    { status: "rejected", error: { code: "invalid_envelope", message: "not an object" } },
  ])("accepts the events.md example $status", (result) => {
    expect(ingestResultSchema.parse(result)).toEqual(result);
  });

  it.each([
    {
      sourceEventId: "e",
      status: "accepted",
      ingestSequence: 0,
      eventId: "0b6c2d8e-6a0f-4f7e-9c1d-2f4b8a6e3c10",
    },
    { sourceEventId: "e", status: "accepted" },
    { sourceEventId: "e", status: "rejected", error: { code: "made_up", message: "x" } },
    { sourceEventId: "e", status: "skipped" },
  ])("rejects a malformed result %#", (result) => {
    expect(ingestResultSchema.safeParse(result).success).toBe(false);
  });
});
