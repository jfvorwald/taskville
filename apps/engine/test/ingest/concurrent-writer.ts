// Worker for the concurrent-writers test: opens its own connection to the
// shared database and ingests its batches as fast as it can.
import { parentPort, workerData } from "node:worker_threads";
import { IngestPipeline } from "../../src/ingest/index.ts";
import { openStorage } from "../../src/storage/index.ts";

const { path, writer, batches, perBatch } = workerData as {
  path: string;
  writer: number;
  batches: number;
  perBatch: number;
};
const storage = openStorage(path, { busyTimeoutMs: 30_000 });
const pipeline = new IngestPipeline({ storage });
const sequences: number[] = [];
for (let b = 0; b < batches; b++) {
  const events = Array.from({ length: perBatch }, (_, i) => ({
    schemaVersion: 1,
    projectId: "demo",
    sourceId: `writer:${writer}`,
    sourceEventId: `w${writer}-b${b}-e${i}`,
    occurredAt: "2026-10-30T11:00:00Z",
    type: "agent.connected",
    agentId: `agent-${writer}`,
    payload: {},
    provenance: "live",
  }));
  for (const result of pipeline.ingest(events).results) {
    if (result.status !== "accepted") throw new Error(`unexpected ${result.status}`);
    sequences.push(result.ingestSequence);
  }
}
storage.close();
parentPort?.postMessage(sequences);
