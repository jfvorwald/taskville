// Ingest timing for a 1,000-event batch (ticket #13: printed, not gated).
// Run: pnpm --filter @taskville/engine run bench:ingest [batchSize] [runs]
// Uses a throwaway database in the OS temp directory, removed afterwards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { clientContentHash, ENGINE_SOURCE_ID, openStorage } from "../storage/index.ts";
import { IngestPipeline } from "./pipeline.ts";

const batchSize = Number(process.argv[2] ?? 1000);
const runs = Number(process.argv[3] ?? 5);

/** A mixed, realistic batch: six agents with sessions, tool calls, activity, and tasks. */
function makeBatch(run: number): unknown[] {
  const events: unknown[] = [];
  const base = Date.parse("2026-10-30T11:00:00Z") + run * 3_600_000;
  for (let i = 0; i < batchSize; i++) {
    const agent = `agent-${i % 6}`;
    const common = {
      schemaVersion: 1,
      projectId: "bench",
      sourceId: "adapter:bench",
      sourceEventId: `r${run}-e${i}`,
      occurredAt: new Date(base + i * 1000).toISOString(),
      agentId: agent,
      sessionId: `sess-${i % 6}`,
      provenance: "live",
    };
    const kind = i % 5;
    if (kind === 0) {
      events.push({
        ...common,
        type: "tool_call.started",
        payload: {
          toolCallId: `tc-${run}-${i}`,
          toolName: "Edit",
          filePaths: [`/repo/src/file-${i % 40}.ts`],
          summary: "edit file",
        },
      });
    } else if (kind === 1) {
      events.push({
        ...common,
        type: "tool_call.finished",
        payload: { toolCallId: `tc-${run}-${i - 1}`, phase: "succeeded", durationMs: 120 },
      });
    } else if (kind === 2) {
      events.push({ ...common, type: "activity.started", payload: { activity: "implementing" } });
    } else if (kind === 3) {
      events.push({
        ...common,
        type: "task.status_changed",
        taskId: `task-${i % 10}`,
        payload: { status: "running", reason: `working on step ${i}` },
      });
    } else {
      events.push({ ...common, type: "session.prompt_submitted", payload: {} });
    }
  }
  return events;
}

const dir = mkdtempSync(join(tmpdir(), "taskville-bench-"));
try {
  const storage = openStorage(join(dir, "taskville.db"));
  storage.transaction((tx) => {
    tx.insertProject({
      id: "bench",
      name: "bench",
      createdAt: new Date().toISOString(),
      roots: [],
      builtin: false,
    });
    const created = {
      schemaVersion: 1 as const,
      eventId: crypto.randomUUID(),
      projectId: "bench",
      sourceId: ENGINE_SOURCE_ID,
      sourceEventId: "project.created:bench",
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      ingestSequence: 1,
      type: "project.created" as const,
      payload: { name: "bench", roots: [], builtin: false },
      evidenceIds: [],
      provenance: "live" as const,
      late: false,
    };
    tx.appendEvent(created, clientContentHash(created));
  });
  const pipeline = new IngestPipeline({ storage });
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    const batch = makeBatch(run);
    const start = performance.now();
    const { results } = pipeline.ingest(batch);
    times.push(performance.now() - start);
    const accepted = results.filter((r) => r.status === "accepted").length;
    if (accepted !== batchSize) throw new Error(`run ${run}: accepted ${accepted} of ${batchSize}`);
  }
  storage.close();
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(`ingest bench: ${runs} runs of a ${batchSize}-event batch, Node ${process.version}`);
  console.log(`  per run (ms): ${times.map((t) => t.toFixed(1)).join(", ")}`);
  console.log(
    `  median ${median.toFixed(1)} ms, ${((batchSize / median) * 1000).toFixed(0)} events/s`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
