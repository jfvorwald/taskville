import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { type ProjectState, projectStateHash, replay } from "@taskville/domain/reducer";
import { eventBatchResponseSchema, storedEnvelopeSchema } from "@taskville/protocol";
import { describe, expect, it, vi } from "vitest";
import { type CommittedBatch, domainReducer, IngestPipeline } from "../../src/ingest/index.ts";
import { addProject, fakeGithubToken, fixedNow, input, useStorage } from "./helpers.ts";

const db = useStorage(["demo", "other"]);

function pipeline(options: Partial<ConstructorParameters<typeof IngestPipeline>[0]> = {}) {
  return new IngestPipeline({ storage: db.storage(), now: fixedNow, ...options });
}

describe("IngestPipeline.ingest", () => {
  it("accepts new events with gap-free per-project sequences and reports heads", () => {
    const response = pipeline().ingest([
      input("e1"),
      input("e2", { type: "agent.disconnected" }),
      input("e1", { projectId: "other" }),
    ]);
    expect(eventBatchResponseSchema.parse(response)).toEqual(response);
    expect(
      response.results.map((r) => [r.status, "ingestSequence" in r && r.ingestSequence]),
    ).toEqual([
      ["accepted", 2],
      ["accepted", 3],
      ["accepted", 2],
    ]);
    expect(response.heads).toEqual({ demo: 3, other: 2 });
    expect(db.storage().head("demo")).toBe(3);
  });

  it("stores envelopes that parse as protocol stored envelopes, with engine fields set", () => {
    const response = pipeline({ newEventId: () => "11111111-1111-4111-8111-111111111111" }).ingest([
      input("e1"),
    ]);
    const [stored] = [...db.storage().events("demo", 1)];
    expect(storedEnvelopeSchema.parse(stored)).toEqual(stored);
    expect(stored).toMatchObject({
      eventId: "11111111-1111-4111-8111-111111111111",
      receivedAt: "2026-10-30T12:00:00.000Z",
      ingestSequence: 2,
      evidenceIds: [],
      late: false,
    });
    expect(response.results[0]).toEqual({
      sourceEventId: "e1",
      status: "accepted",
      ingestSequence: 2,
      eventId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("returns the original acknowledgment for a duplicate, whatever the key order", () => {
    const first = pipeline().ingest([input("e1")]).results[0];
    const reordered = Object.fromEntries(Object.entries(input("e1")).reverse());
    const again = pipeline().ingest([reordered, input("e1")]);
    expect(again.results).toEqual([
      { ...first, status: "duplicate" },
      { ...first, status: "duplicate" },
    ]);
    expect(db.storage().head("demo")).toBe(2);
  });

  it("treats a changed resend under the same key as a conflict and keeps the original", () => {
    const first = pipeline().ingest([input("e1")]).results[0];
    const changed = pipeline().ingest([input("e1", { occurredAt: "2026-10-30T11:00:01Z" })]);
    expect(changed.results).toEqual([
      {
        sourceEventId: "e1",
        status: "conflict",
        existingEventId: first && "eventId" in first ? first.eventId : "",
      },
    ]);
    expect(db.storage().head("demo")).toBe(2);
    expect([...db.storage().events("demo", 1)][0]?.occurredAt).toBe("2026-10-30T11:00:00Z");
  });

  it("detects duplicates and conflicts within one batch", () => {
    const response = pipeline().ingest([
      input("e1"),
      input("e1"),
      input("e1", { agentId: "agent-2" }),
    ]);
    expect(response.results.map((r) => r.status)).toEqual(["accepted", "duplicate", "conflict"]);
  });

  it("commits the valid events of a partial batch and leaves no gap for rejected ones", () => {
    const response = pipeline().ingest([
      input("e1"),
      input("bad", { type: "no.such.type" }),
      { not: "an event" },
      "not even an object",
      input("e2"),
    ]);
    expect(response.results.map((r) => r.status)).toEqual([
      "accepted",
      "rejected",
      "rejected",
      "rejected",
      "accepted",
    ]);
    expect(response.results[4]).toMatchObject({ ingestSequence: 3 });
    expect(response.results[1]).toEqual({
      sourceEventId: "bad",
      status: "rejected",
      error: expect.objectContaining({ code: "unknown_type", path: "type" }),
    });
    expect(response.results[2]).not.toHaveProperty("sourceEventId");
  });

  it("rejects an unknown project with unknown_project and creates nothing", () => {
    const response = pipeline().ingest([input("e1", { projectId: "ghost" })]);
    expect(response.results).toEqual([
      {
        sourceEventId: "e1",
        status: "rejected",
        error: expect.objectContaining({ code: "unknown_project", path: "projectId" }),
      },
    ]);
    expect(response.heads).toEqual({});
    expect(db.storage().project("ghost")).toBeUndefined();
    expect(
      db
        .storage()
        .projects()
        .map((p) => p.id),
    ).toEqual(["demo", "other", "unsorted"]);
  });

  it("applies producer policy: engine-only types, reserved sources, provenance", () => {
    const response = pipeline().ingest([
      input("a", { type: "request.expired", payload: { requestId: "r1" } }),
      input("b", { sourceId: "taskville:bridge" }),
      input("c", { sourceId: "demo:1" }),
      input("d", { provenance: "demo" }),
      input("e", { sourceId: "demo:1", provenance: "demo" }),
    ]);
    expect(
      response.results.map((r) => (r.status === "rejected" ? r.error.code : r.status)),
    ).toEqual([
      "engine_only_type",
      "reserved_source",
      "provenance_mismatch",
      "provenance_mismatch",
      "accepted",
    ]);
  });

  it("passes a producer-set late flag through to the stored envelope", () => {
    pipeline().ingest([input("e1", { late: true })]);
    expect([...db.storage().events("demo", 1)][0]?.late).toBe(true);
  });

  it("writes a projection equal to a replay of the stored events", () => {
    const p = pipeline();
    p.ingest([
      input("r1", {
        type: "agent.registered",
        payload: {
          sourceAgentId: "s1",
          displayName: "Builder",
          role: "implementer",
          kind: "session",
        },
      }),
      input("s1", { type: "session.started", sessionId: "sess-1", payload: {} }),
    ]);
    p.ingest([
      input("t1", { type: "task.created", taskId: "task-1", payload: { title: "Do it" } }),
    ]);

    const projection = db.storage().projection<ProjectState>("demo");
    const replayed = replay("demo", db.storage().events("demo"));
    expect(projection?.head).toBe(4);
    expect(projection?.stateHash).toBe(projectStateHash(replayed));
    expect(projection?.reducerVersion).toBe(domainReducer.version);
  });

  it("repairs a missing projection by replaying the log before applying the batch", () => {
    pipeline().ingest([input("e2")]);
    expect(db.storage().projection("unsorted")).toBeUndefined();
    pipeline().ingest([input("u1", { projectId: "unsorted" })]);
    const projection = db.storage().projection<ProjectState>("unsorted");
    expect(projection?.head).toBe(2);
    expect(projection?.stateHash).toBe(
      projectStateHash(replay("unsorted", db.storage().events("unsorted"))),
    );
  });
});

describe("hostile input", () => {
  it("rejects a string with a lone surrogate per event, keeping its valid siblings", () => {
    const response = pipeline().ingest([
      input("e1"),
      input("t1", {
        type: "task.created",
        taskId: "task-1",
        payload: { title: "bad \ud800 title" },
      }),
      input("e2", { agentId: "agent-\udc00" }),
      input("e3"),
    ]);
    expect(response.results.map((r) => (r.status === "rejected" ? r.error : r.status))).toEqual([
      "accepted",
      expect.objectContaining({ code: "invalid_payload", path: "payload.title" }),
      expect.objectContaining({ code: "invalid_envelope", path: "agentId" }),
      "accepted",
    ]);
    expect(db.storage().head("demo")).toBe(3);
  });

  it("reports the head of a project whose ID is __proto__", () => {
    addProject(db.storage(), "__proto__");
    const onCommit = vi.fn();
    const response = pipeline({ onCommit }).ingest([input("e1", { projectId: "__proto__" })]);
    expect(Object.hasOwn(response.heads, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(response)).heads).toEqual(JSON.parse('{"__proto__":2}'));
    expect(Object.hasOwn(onCommit.mock.calls[0]?.[0].heads ?? {}, "__proto__")).toBe(true);
  });

  it("keeps a masked sourceValue within its 200 UTF-16 unit limit", () => {
    const sourceValue = `${"\u{1F600}".repeat(90)} password=x`;
    expect(sourceValue.length).toBeLessThanOrEqual(200);
    const response = pipeline().ingest([
      input("t1", {
        type: "task.status_changed",
        taskId: "task-1",
        payload: { status: sourceValue },
      }),
    ]);
    expect(response.results[0]?.status).toBe("accepted");
    const stored = [...db.storage().events("demo", 1)][0]?.payload as { sourceValue: string };
    expect(stored.sourceValue.length).toBeLessThanOrEqual(200);
    expect(stored.sourceValue).not.toContain("password=x");
    expect(stored.sourceValue.isWellFormed()).toBe(true);
  });
});

describe("commit and broadcast", () => {
  it("calls onCommit after COMMIT with only the accepted envelopes", () => {
    const seen: number[] = [];
    const onCommit = vi.fn((_batch: CommittedBatch) => {
      // A second connection sees the events, so the commit happened first.
      const raw = new DatabaseSync(db.path());
      try {
        const row = raw.prepare("SELECT head FROM projects WHERE id = 'demo'").get();
        seen.push(Number(row?.head));
      } finally {
        raw.close();
      }
    });
    pipeline({ onCommit }).ingest([
      input("e1"),
      input("e1"),
      input("bad", { type: "x" }),
      input("e2"),
    ]);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([3]);
    // Asserted here, not in the hook: the pipeline swallows hook errors.
    const batch = onCommit.mock.calls[0]?.[0];
    expect(batch?.events.map((e) => e.sourceEventId)).toEqual(["e1", "e2"]);
    expect(batch?.heads).toEqual({ demo: 3 });
  });

  it("gives onCommit heads only for projects that accepted an event", () => {
    const onCommit = vi.fn();
    pipeline({ onCommit }).ingest([
      input("e1"),
      input("t1", {
        projectId: "other",
        type: "task.created",
        taskId: "task-1",
        payload: { title: "\u0001" },
      }),
    ]);
    expect(onCommit.mock.calls[0]?.[0].heads).toEqual({ demo: 2 });
  });

  it("does not call onCommit when nothing was accepted", () => {
    const onCommit = vi.fn();
    pipeline({ onCommit }).ingest([input("bad", { type: "x" })]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rolls back the whole batch, head and projection included, when applying fails", () => {
    pipeline().ingest([input("e1")]);
    const before = db.storage().projection("demo");
    const onCommit = vi.fn();
    let calls = 0;
    const failing = {
      ...domainReducer,
      apply: (state: ProjectState, event: Parameters<typeof domainReducer.apply>[1]) => {
        calls += 1;
        if (calls === 2) throw new Error("reducer exploded");
        return domainReducer.apply(state, event);
      },
    };
    expect(() =>
      pipeline({ reducer: failing, onCommit }).ingest([input("e2"), input("e3")]),
    ).toThrow("reducer exploded");
    expect(db.storage().head("demo")).toBe(2);
    expect(db.storage().projection("demo")).toEqual(before);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("still answers when the broadcast hook throws, since the batch is committed", () => {
    const response = pipeline({
      onCommit: () => {
        throw new Error("subscriber broke");
      },
    }).ingest([input("e1")]);
    expect(response.results[0]?.status).toBe("accepted");
    expect(db.storage().head("demo")).toBe(2);
  });
});

describe("masking and truncation (FR-017)", () => {
  const token = fakeGithubToken();

  it("stores a reason with a fake token masked and truncated, with both flags set", () => {
    const reason = `push failed with ${token} ${"x".repeat(400)}`;
    pipeline().ingest([
      input("f1", { type: "session.turn_failed", sessionId: "sess-1", payload: { reason } }),
    ]);
    const [stored] = [...db.storage().events("demo", 1)];
    const payload = stored?.payload as {
      reason: { text: string; masked: boolean; truncated: boolean };
    };
    expect(payload.reason.masked).toBe(true);
    expect(payload.reason.truncated).toBe(true);
    expect([...payload.reason.text]).toHaveLength(280);
    expect(payload.reason.text).toContain("[REDACTED:");
    expect(payload.reason.text).not.toContain(token);
  });

  it("sets neither flag for a short clean reason", () => {
    pipeline().ingest([
      input("f1", {
        type: "session.turn_failed",
        sessionId: "sess-1",
        payload: { reason: "tests failed" },
      }),
    ]);
    expect([...db.storage().events("demo", 1)][0]?.payload).toEqual({
      reason: { text: "tests failed", masked: false, truncated: false },
    });
  });

  it("masks every free-text payload string but leaves IDs, enums and timestamps alone", () => {
    pipeline().ingest([
      input("q1", {
        type: "request.opened",
        sessionId: "sess-1",
        payload: {
          requestId: "req-1",
          kind: "permission",
          toolName: "Bash",
          inputPreview: `curl -H "Authorization: Bearer ${token}" https://example.test`,
          expiresAt: "2026-10-30T11:05:00Z",
        },
      }),
      input("t1", {
        type: "task.created",
        taskId: "task-1",
        payload: { title: `rotate ${token}`, relatedTaskIds: ["task-0"] },
      }),
    ]);
    const [opened, task] = [...db.storage().events("demo", 1)];
    expect(opened?.payload).toMatchObject({
      requestId: "req-1",
      kind: "permission",
      toolName: "Bash",
      expiresAt: "2026-10-30T11:05:00Z",
    });
    expect(JSON.stringify(opened?.payload)).not.toContain(token);
    expect(task?.payload).toEqual({
      title: "rotate [REDACTED:github-token]",
      relatedTaskIds: ["task-0"],
    });
  });

  it("strips control characters from payload text before masking", () => {
    pipeline().ingest([
      input("t1", {
        type: "task.created",
        taskId: "task-1",
        payload: { title: "a\u001b[31mred\u0007\u0000 line\nnext\ttab\r" },
      }),
    ]);
    expect([...db.storage().events("demo", 1)][0]?.payload).toEqual({
      title: "a[31mred line\nnext\ttab",
    });
  });

  it("rejects text that is empty once control characters are stripped", () => {
    const response = pipeline().ingest([
      input("t1", { type: "task.created", taskId: "task-1", payload: { title: "\u0001\u0002" } }),
    ]);
    expect(response.results[0]).toMatchObject({
      status: "rejected",
      error: { code: "invalid_payload", path: "payload.title" },
    });
    expect(db.storage().head("demo")).toBe(1);
  });

  it("hashes the masked reason before truncation: a difference past 280 is a conflict", () => {
    const base = "y".repeat(300);
    const event = (tail: string) =>
      input("f1", {
        type: "session.turn_failed",
        sessionId: "s",
        payload: { reason: base + tail },
      });
    pipeline().ingest([event("a")]);
    expect(pipeline().ingest([event("b")]).results[0]?.status).toBe("conflict");
    expect(pipeline().ingest([event("a")]).results[0]?.status).toBe("duplicate");
  });

  it("treats two secrets that mask to the same text under one key as a duplicate (R-13)", () => {
    const event = (secret: string) =>
      input("f1", {
        type: "session.turn_failed",
        sessionId: "s",
        payload: { reason: `token ${secret}` },
      });
    pipeline().ingest([event(fakeGithubToken(1))]);
    expect(pipeline().ingest([event(fakeGithubToken(2))]).results[0]?.status).toBe("duplicate");
  });

  it("never writes the unmasked secret to the database files", () => {
    pipeline().ingest([
      input("f1", {
        type: "session.turn_failed",
        sessionId: "s",
        payload: { reason: `oops ${token}` },
      }),
      input("t1", { type: "task.created", taskId: "task-1", payload: { title: token } }),
    ]);
    db.storage().close();
    for (const suffix of ["", "-wal"]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(db.path() + suffix);
      } catch {
        continue;
      }
      expect(bytes.includes(Buffer.from(token))).toBe(false);
    }
  });
});
