import type { StoredEnvelope } from "../../../src/data/domain.ts";

// Stored-envelope builders shared by the celebration tests. Payload shapes follow
// packages/protocol/src/payloads.ts (stored form).

let seq = 0;

function envelope(
  type: string,
  payload: Record<string, unknown>,
  extra: Partial<Record<"agentId" | "taskId" | "provenance", string>> = {},
): StoredEnvelope {
  seq += 1;
  return {
    schemaVersion: 1,
    projectId: "unsorted",
    sourceId: "hooks",
    sourceEventId: `src-${seq}`,
    occurredAt: "2026-10-31T12:00:00.000Z",
    evidenceIds: [],
    provenance: "live",
    late: false,
    eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    receivedAt: "2026-10-31T12:00:00.000Z",
    ingestSequence: seq,
    type,
    payload,
    ...extra,
  } as unknown as StoredEnvelope;
}

export const taskCompleted = (agentId = "a1", taskId = "t1") =>
  envelope("task.status_changed", { status: "completed" }, { agentId, taskId });

export const taskRunning = (agentId = "a1", taskId = "t1") =>
  envelope("task.status_changed", { status: "running" }, { agentId, taskId });

export const handoff = (fromAgentId = "a1", toAgentId = "a2", taskId = "t1") =>
  envelope("task.handoff", { fromAgentId, toAgentId }, { taskId });

export const gitMerge = () =>
  envelope("git.merge", {
    repo: "taskville",
    sha: "a".repeat(40),
    parents: ["b".repeat(40), "c".repeat(40)],
  });

export const testRed = (agentId = "a1") =>
  envelope("test.result", { passed: 8, failed: 2, skipped: 0 }, { agentId });

export const testGreen = (agentId = "a1") =>
  envelope("test.result", { passed: 10, failed: 0, skipped: 0 }, { agentId });

/** A Bash command that only looks like a test run: activity `testing`, flagged heuristic. */
export const guessedTestRun = (agentId = "a1") =>
  envelope("activity.started", { activity: "testing", heuristic: true }, { agentId });

export const activityEnded = (agentId = "a1") => envelope("activity.ended", {}, { agentId });
