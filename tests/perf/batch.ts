// SC-004: a batch of 1,000 events is ingested and acknowledged in under 1 second.
// Two measurements: the M1.12 in-process bench (`apps/engine/src/ingest/bench.ts`, reused as is),
// and the end-to-end time of `POST /v1/events/batch` with 1,000 demo events against a spawned
// `taskville serve` (HTTP, JSON parsing, validation, masking, commit, and the response).
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { demoSteps, LIVELY } from "../../packages/demo/src/index.ts";
import { createProject, startEngine } from "./engine.ts";
import { type Summary, summarize } from "./stats.ts";

export const BATCH_TARGET_MS = 1000;
const BENCH = resolve(import.meta.dirname, "../../apps/engine/src/ingest/bench.ts");

export interface BatchResult {
  batchSize: number;
  runs: number;
  http: Summary;
  httpRunsMs: number[];
  inProcessOutput: string;
  pass: boolean;
}

function demoBatch(run: number, size: number): unknown[] {
  const events: unknown[] = [];
  const startAtMs = Date.parse("2026-10-30T09:00:00Z") + run * 86_400_000;
  for (const step of demoSteps({ seed: 100 + run, pace: LIVELY, projectId: "batch", startAtMs })) {
    for (const event of step.events) {
      events.push(event);
      if (events.length === size) return events;
    }
  }
  return events;
}

export async function batchCheck(
  options: { runs?: number; size?: number } = {},
): Promise<BatchResult> {
  const runs = options.runs ?? 5;
  const size = options.size ?? 1000;
  const inProcessOutput = execFileSync(process.execPath, [BENCH, String(size), String(runs)])
    .toString()
    .trim();
  const engine = await startEngine();
  try {
    await createProject(engine, "batch");
    const times: number[] = [];
    for (let run = 0; run < runs; run++) {
      const events = demoBatch(run, size);
      const start = performance.now();
      const response = await engine.ingest(events);
      times.push(performance.now() - start);
      const accepted = response.results.filter((r) => r.status === "accepted").length;
      if (accepted !== size) throw new Error(`run ${run}: accepted ${accepted} of ${size}`);
    }
    const http = summarize(times);
    return {
      batchSize: size,
      runs,
      http,
      httpRunsMs: times,
      inProcessOutput,
      pass: http.max < BATCH_TARGET_MS,
    };
  } finally {
    await engine.stop();
  }
}
