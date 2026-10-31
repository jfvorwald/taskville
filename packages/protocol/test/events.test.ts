import { describe, expect, it } from "vitest";
import {
  ENGINE_ONLY_EVENT_TYPES,
  EVENT_TYPES,
  inputEventSchema,
  parseInputEvent,
  storedEnvelopeSchema,
} from "../src/index.ts";
import { invalidPayloads, storedFrom, validPayloads, wireEvent } from "./fixtures.ts";

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("event types", () => {
  it("lists every v1 family from events.md", () => {
    const families = new Set(EVENT_TYPES.map((t) => t.split(".")[0]));
    expect([...families].sort()).toEqual(
      [
        "activity",
        "agent",
        "command",
        "git",
        "project",
        "request",
        "session",
        "task",
        "team",
        "test",
        "tool_call",
      ].sort(),
    );
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it("marks exactly the engine-only types from events.md", () => {
    expect([...ENGINE_ONLY_EVENT_TYPES].sort()).toEqual(
      [
        "project.created",
        "request.resolved",
        "request.expired",
        "command.requested",
        "command.delivered",
        "command.succeeded",
        "command.expired",
        "command.unsupported",
        "command.failed",
      ].sort(),
    );
  });
});

describe.each(EVENT_TYPES)("%s", (type) => {
  it("round-trips an input event through JSON", () => {
    const first = parseInputEvent(wireEvent(type, validPayloads[type]));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.event.type).toBe(type);
    const second = parseInputEvent(roundTrip(first.event));
    expect(second).toEqual(first);
    expect(inputEventSchema.parse(roundTrip(first.event))).toEqual(first.event);
  });

  it("round-trips a stored envelope through JSON", () => {
    const parsed = parseInputEvent(wireEvent(type, validPayloads[type]));
    if (!parsed.ok) throw new Error(`fixture for ${type} is invalid`);
    const stored = storedEnvelopeSchema.parse(storedFrom(parsed.event));
    expect(stored.type).toBe(type);
    expect(storedEnvelopeSchema.parse(roundTrip(stored))).toEqual(stored);
  });

  it("rejects an invalid payload as invalid_payload with its path", () => {
    const { payload, path } = invalidPayloads[type];
    const result = parseInputEvent(wireEvent(type, payload));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_payload");
    expect(result.error.path).toBe(path);
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  it("rejects a stored envelope whose payload is invalid", () => {
    const stored = storedFrom(wireEvent(type, invalidPayloads[type].payload, { late: false }));
    expect(storedEnvelopeSchema.safeParse({ ...stored, evidenceIds: [] }).success).toBe(false);
  });
});

describe("envelope", () => {
  const ok = (overrides: Record<string, unknown>) =>
    parseInputEvent(wireEvent("agent.connected", {}, overrides));

  it("applies defaults for evidenceIds and late", () => {
    const result = ok({});
    expect(result.ok && result.event.evidenceIds).toEqual([]);
    expect(result.ok && result.event.late).toBe(false);
  });

  it("keeps optional fields that were sent", () => {
    const result = ok({
      sourceSequence: 7,
      correlationId: "corr-1",
      evidenceIds: ["ev-1"],
      late: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.sourceSequence).toBe(7);
    expect(result.event.correlationId).toBe("corr-1");
    expect(result.event.evidenceIds).toEqual(["ev-1"]);
    expect(result.event.late).toBe(true);
  });

  it.each([
    ["schemaVersion 2", { schemaVersion: 2 }, "unsupported_schema_version"],
    ['schemaVersion "1"', { schemaVersion: "1" }, "unsupported_schema_version"],
    ["missing schemaVersion", { schemaVersion: undefined }, "invalid_envelope"],
    ["unknown type", { type: "agent.exploded" }, "unknown_type"],
    ["missing type", { type: undefined }, "invalid_envelope"],
    ["empty sourceId", { sourceId: "" }, "invalid_envelope"],
    ["sourceId over 200 chars", { sourceId: "s".repeat(201) }, "invalid_envelope"],
    ["sourceEventId over 200 chars", { sourceEventId: "e".repeat(201) }, "invalid_envelope"],
    ["missing projectId", { projectId: undefined }, "invalid_envelope"],
    ["occurredAt without offset", { occurredAt: "2026-10-30T12:00:00" }, "invalid_envelope"],
    ["occurredAt not a date", { occurredAt: "yesterday" }, "invalid_envelope"],
    ["unknown provenance", { provenance: "guessed" }, "invalid_envelope"],
    ["negative sourceSequence", { sourceSequence: -1 }, "invalid_envelope"],
    ["fractional sourceSequence", { sourceSequence: 1.5 }, "invalid_envelope"],
    ["unknown top-level field", { colour: "red" }, "invalid_envelope"],
    ["engine-assigned eventId", { eventId: "x" }, "invalid_envelope"],
    ["non-boolean late", { late: "yes" }, "invalid_envelope"],
    ["missing payload", { payload: undefined }, "invalid_envelope"],
  ])("rejects %s", (_label, overrides, code) => {
    const result = ok(overrides);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it.each([null, 42, "event", [1, 2]])("rejects a non-object %j as invalid_envelope", (raw) => {
    const result = parseInputEvent(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_envelope");
  });

  it("reports the envelope path of the first problem", () => {
    const result = ok({ sourceId: "" });
    expect(!result.ok && result.error.path).toBe("sourceId");
  });

  it("accepts an occurredAt with a non-UTC offset", () => {
    expect(ok({ occurredAt: "2026-10-30T14:00:00+02:00" }).ok).toBe(true);
  });

  it.each([
    ["agent.connected", "agentId"],
    ["session.started", "sessionId"],
    ["session.turn_ended", "agentId"],
    ["task.created", "taskId"],
    ["activity.started", "agentId"],
    ["tool_call.started", "agentId"],
    ["request.opened", "agentId"],
  ] as const)("%s requires envelope %s", (type, field) => {
    const result = parseInputEvent(wireEvent(type, validPayloads[type], { [field]: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_envelope");
    expect(result.error.path).toBe(field);
  });

  it("does not require agent, session, or task IDs on Git events", () => {
    const result = parseInputEvent(
      wireEvent("git.commit", validPayloads["git.commit"], {
        agentId: undefined,
        sessionId: undefined,
        taskId: undefined,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("requires engine-assigned fields on a stored envelope", () => {
    const parsed = parseInputEvent(wireEvent("agent.connected", {}));
    if (!parsed.ok) throw new Error("fixture invalid");
    const stored = storedFrom(parsed.event);
    for (const field of ["eventId", "receivedAt", "ingestSequence"]) {
      expect(storedEnvelopeSchema.safeParse({ ...stored, [field]: undefined }).success).toBe(false);
    }
    expect(storedEnvelopeSchema.safeParse({ ...stored, eventId: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(storedEnvelopeSchema.safeParse({ ...stored, ingestSequence: 0 }).success).toBe(false);
  });
});
