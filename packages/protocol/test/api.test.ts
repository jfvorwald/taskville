import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  apiErrorSchema,
  attentionSchema,
  createProjectRequestSchema,
  createProjectResponseSchema,
  eventBatchRequestSchema,
  eventBatchResponseSchema,
  healthResponseSchema,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  pairingRequestSchema,
  pairingResponseSchema,
  pairingRevokeResponseSchema,
  parseInputEvent,
  projectsResponseSchema,
  RESNAPSHOT_REASONS,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_SUBSCRIBER_QUEUE_LIMIT,
  snapshotResponseSchema,
  sseFrameSchema,
} from "../src/index.ts";
import { storedFrom, validPayloads, wireEvent } from "./fixtures.ts";

const UUID = "0b6c2d8e-6a0f-4f7e-9c1d-2f4b8a6e3c10";
const reason = { text: "Bash wants to run", masked: false, truncated: false };

describe("error shape", () => {
  it("is { error: { code, message } }", () => {
    const body = { error: { code: "unknown_project", message: "No project 'x'" } };
    expect(apiErrorSchema.parse(body)).toEqual(body);
    expect(apiErrorSchema.safeParse({ code: "unknown_project", message: "x" }).success).toBe(false);
  });

  it("covers every code named in http-api.md", () => {
    for (const code of [
      "forbidden_host",
      "forbidden_origin",
      "unauthorized",
      "credential_not_allowed",
      "invalid_pairing_code",
      "project_exists",
      "unknown_project",
      "not_implemented",
    ]) {
      expect(API_ERROR_CODES).toContain(code);
    }
    expect(apiErrorSchema.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(
      false,
    );
  });
});

describe("batch", () => {
  it("accepts any array of events, leaving per-event validation to the results", () => {
    expect(eventBatchRequestSchema.parse({ events: [{}, 1] })).toEqual({ events: [{}, 1] });
    expect(eventBatchRequestSchema.safeParse({ events: "x" }).success).toBe(false);
    expect(eventBatchRequestSchema.safeParse({}).success).toBe(false);
  });

  it("exposes the batch limits", () => {
    expect(MAX_BATCH_EVENTS).toBe(5000);
    expect(MAX_BATCH_BYTES).toBe(5 * 1024 * 1024);
  });

  it("responds with results and a heads map per project", () => {
    const body = {
      results: [
        { sourceEventId: "e-1", status: "accepted", ingestSequence: 2, eventId: UUID },
        {
          sourceEventId: "e-2",
          status: "rejected",
          error: { code: "unknown_project", message: "never added" },
        },
      ],
      heads: { "proj-a": 2, unsorted: 1 },
    };
    expect(eventBatchResponseSchema.parse(body)).toEqual(body);
    expect(eventBatchResponseSchema.safeParse({ ...body, heads: { a: -1 } }).success).toBe(false);
    expect(eventBatchResponseSchema.safeParse({ results: [], head: 3 }).success).toBe(false);
  });
});

describe("projects", () => {
  it("creates a project from name and absolute roots", () => {
    expect(createProjectRequestSchema.parse({ name: "Taskville", roots: ["/repo/x"] })).toEqual({
      name: "Taskville",
      roots: ["/repo/x"],
    });
    expect(
      createProjectRequestSchema.safeParse({ id: "tv", name: "T", roots: ["C:\\repo"] }).success,
    ).toBe(true);
    expect(createProjectRequestSchema.safeParse({ name: "T", roots: ["repo/x"] }).success).toBe(
      false,
    );
    expect(createProjectRequestSchema.safeParse({ name: "", roots: [] }).success).toBe(false);
    expect(
      createProjectResponseSchema.parse({ id: "tv", name: "T", roots: ["/r"], head: 1 }),
    ).toEqual({ id: "tv", name: "T", roots: ["/r"], head: 1 });
  });

  it("lists projects with builtin and head", () => {
    const body = {
      projects: [{ id: "unsorted", name: "Unsorted", roots: [], builtin: true, head: 1 }],
    };
    expect(projectsResponseSchema.parse(body)).toEqual(body);
    expect(
      projectsResponseSchema.safeParse({ projects: [{ id: "x", name: "X", roots: [] }] }).success,
    ).toBe(false);
  });
});

describe("snapshot and attention", () => {
  const attention = {
    agentId: "agent-1",
    level: "needs_you",
    kind: "permission",
    reason,
    since: "2026-10-30T12:00:00Z",
    requestId: "req-1",
    heuristic: false,
  };

  it("parses a snapshot with opaque state and attention outside the state", () => {
    const body = {
      projectId: "proj-a",
      cursor: 43,
      reducerVersion: 1,
      stateHash: "sha256:abc",
      state: { agents: {} },
      attention: [attention],
      computedAt: "2026-10-30T12:00:05Z",
    };
    expect(snapshotResponseSchema.parse(body)).toEqual(body);
  });

  it.each([
    ["needs_you", ["permission", "elicitation", "input"]],
    ["trouble", ["stop_failure", "tool_failures", "silent"]],
    ["waiting", ["turn_ended", "idle_prompt"]],
  ])("allows only %s kinds for that level", (level, kinds) => {
    for (const kind of kinds) {
      expect(attentionSchema.safeParse({ ...attention, level, kind }).success).toBe(true);
    }
    const other = level === "waiting" ? "permission" : "turn_ended";
    expect(attentionSchema.safeParse({ ...attention, level, kind: other }).success).toBe(false);
  });

  it("stores the reason in its masked and truncated form", () => {
    expect(attentionSchema.safeParse({ ...attention, reason: "plain" }).success).toBe(false);
  });
});

describe("pairing and health", () => {
  it("parses the pairing exchange and revoke", () => {
    expect(pairingRequestSchema.parse({ code: "abc" })).toEqual({ code: "abc" });
    expect(pairingRequestSchema.safeParse({ code: "" }).success).toBe(false);
    expect(pairingResponseSchema.parse({ session: "s" })).toEqual({ session: "s" });
    expect(pairingRevokeResponseSchema.parse({ revoked: 2 })).toEqual({ revoked: 2 });
  });

  it("parses health in both states", () => {
    const ok = { status: "ok", db: "ok", walMode: true, uptimeSeconds: 12, version: "0.0.0" };
    expect(healthResponseSchema.parse(ok)).toEqual(ok);
    expect(healthResponseSchema.parse({ ...ok, status: "error", db: "error" })).toBeTruthy();
    expect(healthResponseSchema.safeParse({ ...ok, db: "maybe" }).success).toBe(false);
  });
});

describe("SSE frames", () => {
  const parsed = parseInputEvent(wireEvent("agent.connected", validPayloads["agent.connected"]));
  if (!parsed.ok) throw new Error("fixture invalid");
  const envelope = storedFrom(parsed.event, 43);

  it("exposes the stream constants", () => {
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(SSE_SUBSCRIBER_QUEUE_LIMIT).toBe(1000);
    expect([...RESNAPSHOT_REASONS].sort()).toEqual(
      ["cursor_ahead_of_head", "reducer_rebuilt", "slow_consumer"].sort(),
    );
  });

  it("parses an event frame whose id is the ingest sequence", () => {
    const frame = { event: "event", id: 43, data: envelope };
    expect(sseFrameSchema.parse(frame)).toEqual(frame);
    expect(sseFrameSchema.safeParse({ ...frame, id: 44 }).success).toBe(false);
  });

  it("parses heartbeat and resnapshot frames", () => {
    expect(sseFrameSchema.parse({ event: "heartbeat", data: { head: 43 } })).toBeTruthy();
    expect(
      sseFrameSchema.parse({ event: "resnapshot", data: { reason: "slow_consumer" } }),
    ).toBeTruthy();
    expect(
      sseFrameSchema.safeParse({ event: "resnapshot", data: { reason: "bored" } }).success,
    ).toBe(false);
    expect(sseFrameSchema.safeParse({ event: "heartbeat", id: 1, data: { head: 1 } }).success).toBe(
      false,
    );
  });
});
