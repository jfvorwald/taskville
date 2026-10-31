// The live producer: posts each visible change as one batch to the ingest route
// (POST /v1/events/batch), pacing steps on the virtual clock. It stays pure: the HTTP call,
// the wait, and the start time are injected by the caller (the CLI's `demo start`).

import type { EventBatchRequest, EventBatchResponse, IngestResult } from "@taskville/protocol";
import type { Pace } from "./pace.ts";
import { demoSteps } from "./scenario.ts";

export interface ProducerOptions {
  readonly seed: number;
  readonly pace: Pace;
  readonly projectId: string;
  /** Epoch milliseconds stamped as simulated time zero (the caller's clock for live runs). */
  readonly startAtMs?: number;
  /** Virtual clock multiplier: 1 is real time, 20 runs twenty times faster. Default 1. */
  readonly speed?: number;
  /** Simulated duration; endless when absent. */
  readonly durationMs?: number;
  readonly post: (batch: EventBatchRequest) => Promise<EventBatchResponse>;
  /** Waits real milliseconds. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Checked before each step; true stops the run (for example on SIGINT). */
  readonly stop?: () => boolean;
}

export interface ProducerSummary {
  steps: number;
  events: number;
  accepted: number;
  duplicate: number;
  /** Simulated time of the last step posted, or -1 if none. */
  lastAtMs: number;
}

/** The engine rejected demo events or reported a conflict: the run stops at that batch. */
export class DemoIngestError extends Error {
  readonly codes: string[];
  readonly results: IngestResult[];
  constructor(results: IngestResult[]) {
    const codes = [
      ...new Set(results.map((r) => (r.status === "rejected" ? r.error.code : r.status))),
    ];
    super(`Demo events not accepted: ${codes.join(", ")}`);
    this.name = "DemoIngestError";
    this.codes = codes;
    this.results = results;
  }
}

export async function runProducer(options: ProducerOptions): Promise<ProducerSummary> {
  const speed = options.speed ?? 1;
  if (!(speed > 0)) throw new Error(`speed must be above zero, got ${speed}`);
  const summary: ProducerSummary = { steps: 0, events: 0, accepted: 0, duplicate: 0, lastAtMs: -1 };
  let previousAt = 0;
  for (const step of demoSteps(options)) {
    if (options.stop?.() === true) break;
    await options.sleep((step.atMs - previousAt) / speed);
    previousAt = step.atMs;
    const response = await options.post({ events: [...step.events] });
    const failed = response.results.filter(
      (r) => r.status === "rejected" || r.status === "conflict",
    );
    if (failed.length > 0) throw new DemoIngestError(failed);
    summary.steps += 1;
    summary.events += step.events.length;
    summary.accepted += response.results.filter((r) => r.status === "accepted").length;
    summary.duplicate += response.results.filter((r) => r.status === "duplicate").length;
    summary.lastAtMs = step.atMs;
  }
  return summary;
}
