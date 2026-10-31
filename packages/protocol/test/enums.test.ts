import { describe, expect, it } from "vitest";
import {
  ACTIVITIES,
  AGENT_KINDS,
  inputPayloadSchemas,
  parseInputEvent,
  storedPayloadSchemas,
  TASK_STATUSES,
} from "../src/index.ts";
import { validPayloads, wireEvent } from "./fixtures.ts";

// Source-supplied enums keep unrecognized values as `unknown` with the original value in
// `sourceValue` (constitution IV, data-model.md "Enumerations").
const openEnums = [
  { type: "task.status_changed", field: "status", values: TASK_STATUSES },
  { type: "activity.started", field: "activity", values: ACTIVITIES },
  { type: "agent.registered", field: "kind", values: AGENT_KINDS },
] as const;

const payloadWith = (type: (typeof openEnums)[number]["type"], extra: Record<string, unknown>) => {
  const base: Record<string, unknown> = { ...validPayloads[type], ...extra };
  if (type === "agent.registered") delete base.parentAgentId;
  return base;
};

describe.each(openEnums)("$type $field", ({ type, field, values }) => {
  const input = inputPayloadSchemas[type];
  const stored = storedPayloadSchemas[type];

  it("includes unknown as a member", () => {
    expect(values).toContain("unknown");
  });

  it("maps an unrecognized value to unknown and keeps it in sourceValue", () => {
    const parsed = input.parse(payloadWith(type, { [field]: "Paused-ish" }));
    expect(parsed).toMatchObject({ [field]: "unknown", sourceValue: "Paused-ish" });
  });

  it("is case-sensitive: a known value in another case is unknown", () => {
    const known = values[0];
    const parsed = input.parse(payloadWith(type, { [field]: known.toUpperCase() }));
    expect(parsed).toMatchObject({ [field]: "unknown", sourceValue: known.toUpperCase() });
  });

  it("passes every known value through unchanged without a sourceValue", () => {
    for (const value of values.filter((v) => v !== "unknown")) {
      const parsed = input.parse(payloadWith(type, { [field]: value }));
      expect(parsed).toMatchObject({ [field]: value });
      expect(parsed).not.toHaveProperty("sourceValue");
    }
  });

  it("drops a sourceValue sent with a known value", () => {
    const known = values.find((v) => v !== "unknown");
    const parsed = input.parse(payloadWith(type, { [field]: known, sourceValue: "x" }));
    expect(parsed).not.toHaveProperty("sourceValue");
  });

  it("keeps a sourceValue sent with unknown, and is idempotent", () => {
    const once = input.parse(payloadWith(type, { [field]: "unknown", sourceValue: "legacy" }));
    expect(once).toMatchObject({ [field]: "unknown", sourceValue: "legacy" });
    expect(input.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("rejects an empty or non-string value", () => {
    expect(input.safeParse(payloadWith(type, { [field]: "" })).success).toBe(false);
    expect(input.safeParse(payloadWith(type, { [field]: 3 })).success).toBe(false);
  });

  it("stored form accepts only canonical values", () => {
    const canonical = input.parse(payloadWith(type, { [field]: "Paused-ish" }));
    expect(stored.safeParse(canonical).success).toBe(true);
    expect(stored.safeParse(payloadWith(type, { [field]: "Paused-ish" })).success).toBe(false);
    const known = values.find((v) => v !== "unknown");
    expect(stored.safeParse(payloadWith(type, { [field]: known, sourceValue: "x" })).success).toBe(
      false,
    );
  });
});

describe("agent kind rules", () => {
  const registered = (payload: Record<string, unknown>) =>
    parseInputEvent(wireEvent("agent.registered", payload));
  const base = { sourceAgentId: "sa-1", displayName: "A", role: "r" };

  it("allows parentAgentId only with subagent", () => {
    expect(registered({ ...base, kind: "subagent", parentAgentId: "p" }).ok).toBe(true);
    for (const kind of ["session", "lead", "teammate"]) {
      expect(registered({ ...base, kind, parentAgentId: "p" }).ok).toBe(false);
    }
  });

  it("allows teamId only with lead or teammate", () => {
    for (const kind of ["lead", "teammate"]) {
      expect(registered({ ...base, kind, teamId: "t" }).ok).toBe(true);
    }
    for (const kind of ["session", "subagent"]) {
      expect(registered({ ...base, kind, teamId: "t" }).ok).toBe(false);
    }
  });

  it("does not guess the rules for an unknown kind", () => {
    const result = registered({ ...base, kind: "worker", parentAgentId: "p", teamId: "t" });
    expect(result.ok).toBe(true);
    if (result.ok && result.event.type === "agent.registered") {
      expect(result.event.payload.kind).toBe("unknown");
      expect(result.event.payload.sourceValue).toBe("worker");
    }
  });
});

// Enums that drive requests, commands, and attention are closed: an unrecognized value rejects.
describe("closed enums", () => {
  it.each([
    ["tool_call.finished", { toolCallId: "tc", phase: "crashed" }, "payload.phase"],
    ["request.opened", { requestId: "r", kind: "approval" }, "payload.kind"],
    ["request.resolved", { requestId: "r", resolution: "ignored" }, "payload.resolution"],
    [
      "command.requested",
      {
        commandId: "c",
        commandType: "shell.run",
        requestId: "r",
        payload: {},
        idempotencyKey: "k",
      },
      "payload.commandType",
    ],
  ] as const)("%s rejects an unknown value", (type, payload, path) => {
    const result = parseInputEvent(wireEvent(type, payload));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe(path);
  });

  it("rejects an unknown provenance", () => {
    const result = parseInputEvent(wireEvent("agent.connected", {}, { provenance: "rumour" }));
    expect(!result.ok && result.error.code).toBe("invalid_envelope");
  });
});
