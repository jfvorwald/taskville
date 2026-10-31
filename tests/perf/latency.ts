// SC-005: a newly ingested event reaches a connected viewer in under 250 ms locally.
// Measured from just before the probe's POST is sent to the moment its SSE frame is parsed by a
// fetch-streamed viewer, against a spawned `taskville serve`. Two phases: an idle engine, and the
// same engine while the six-agent demo (lively pace) streams into the same project.
import { CALM, LIVELY, runProducer } from "../../packages/demo/src/index.ts";
import { createProject, type RunningEngine, startEngine } from "./engine.ts";
import { type Summary, summarize } from "./stats.ts";
import { connectViewer, PROBE_PREFIX, type Viewer } from "./viewer.ts";

export const LATENCY_TARGET_MS = 250;

export interface LatencyPhase {
  name: string;
  /** POST start to SSE frame, milliseconds. */
  viewer: Summary;
  /** POST start to the 200 acknowledgment, milliseconds. */
  ack: Summary;
  demoEvents: number;
  anomalies: number;
}

export interface LatencyResult {
  probes: number;
  gapMs: number;
  phases: LatencyPhase[];
  pass: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function probe(
  engine: RunningEngine,
  viewer: Viewer,
  phase: string,
  count: number,
  gapMs: number,
) {
  const toViewer: number[] = [];
  const toAck: number[] = [];
  for (let i = 0; i < count; i++) {
    const sourceEventId = `${PROBE_PREFIX}${phase}-${i}`;
    const arrival = viewer.arrival(sourceEventId);
    const start = performance.now();
    const response = await engine.ingest([
      {
        schemaVersion: 1,
        projectId: "perf",
        sourceId: "perf:probe",
        sourceEventId,
        occurredAt: new Date().toISOString(),
        type: "agent.connected",
        agentId: "probe-agent",
        payload: {},
        provenance: "live",
      },
    ]);
    toAck.push(performance.now() - start);
    if (response.results[0]?.status !== "accepted") throw new Error(`probe ${i} not accepted`);
    toViewer.push((await arrival) - start);
    await sleep(gapMs);
  }
  return { viewer: summarize(toViewer), ack: summarize(toAck) };
}

/** SC-005 says every new event arrives in under 250 ms, so the gate is the slowest probe. */
export function latencyPass(phases: readonly LatencyPhase[]): boolean {
  return phases.every((p) => p.viewer.max < LATENCY_TARGET_MS && p.anomalies === 0);
}

export async function latencyCheck(options: { probes?: number; gapMs?: number } = {}) {
  const probes = options.probes ?? 1000;
  const gapMs = options.gapMs ?? 10;
  const engine = await startEngine();
  try {
    await createProject(engine, "perf");
    const viewer = await connectViewer(engine, "perf", 1);
    const phases: LatencyPhase[] = [];

    const idle = await probe(engine, viewer, "idle", probes, gapMs);
    phases.push({ name: "idle engine", ...idle, demoEvents: 0, anomalies: viewer.anomalies });

    // The six-agent demo at lively pace, 60x faster than real time, into the same project.
    let stop = false;
    let demoEvents = 0;
    const demo = runProducer({
      seed: 7,
      pace: LIVELY,
      projectId: "perf",
      startAtMs: Date.now(),
      speed: 60,
      now: () => Date.now(),
      sleep,
      stop: () => stop,
      post: async (batch) => {
        const response = await engine.ingest(batch.events);
        demoEvents += batch.events.length;
        return response;
      },
    });
    const loaded = await probe(engine, viewer, "loaded", probes, gapMs);
    stop = true;
    await demo;
    phases.push({
      name: "with the six-agent demo (lively, 60x)",
      ...loaded,
      demoEvents,
      anomalies: viewer.anomalies,
    });
    viewer.close();
    const pass = latencyPass(phases);
    return { probes, gapMs, phases, pass } satisfies LatencyResult;
  } finally {
    await engine.stop();
  }
}

export { CALM };
