// Offline mode (contracts/cli.md `demo run --offline`): runs the scenario through the reducer in
// process, with no engine, and returns the final stateHash.

import { type ProjectState, projectStateHash, replay } from "@taskville/domain/reducer";
import {
  parseInputEvent,
  producerPolicyViolation,
  REASON_MAX_CHARS,
  type StoredEnvelope,
  storedEnvelopeSchema,
} from "@taskville/protocol";
import type { Pace } from "./pace.ts";
import { type DemoEvent, generateDemo } from "./scenario.ts";

/**
 * Stores input events the way ingest would for this demo: validated and checked against the
 * batch route's producer policy (throws otherwise), `reason` in its stored form, gap-free
 * `ingestSequence` from 1, `receivedAt` equal to `occurredAt`, and deterministic event IDs.
 * Masking is a no-op here because the scenario's text contains no secrets (tested against the
 * redaction module), and every reason is under the 280-character limit (checked).
 */
export function toStoredEvents(events: readonly DemoEvent[], projectId: string): StoredEnvelope[] {
  return events.map((raw, index) => {
    const parsed = parseInputEvent(raw);
    if (!parsed.ok) {
      throw new Error(
        `Demo event ${index + 1} rejected: ${parsed.error.code} ${parsed.error.path ?? ""} ${parsed.error.message}`,
      );
    }
    const violation = producerPolicyViolation(parsed.event);
    if (violation !== undefined)
      throw new Error(`Demo event ${index + 1} rejected: ${violation.code}`);
    if (parsed.event.projectId !== projectId) {
      throw new Error(
        `Demo event ${index + 1} is for project ${parsed.event.projectId}, not ${projectId}`,
      );
    }
    const payload: Record<string, unknown> = { ...parsed.event.payload };
    if (typeof payload.reason === "string") {
      if ([...payload.reason].length > REASON_MAX_CHARS)
        throw new Error(`Demo reason too long: ${payload.reason}`);
      payload.reason = { text: payload.reason, masked: false, truncated: false };
    }
    const ingestSequence = index + 1;
    return storedEnvelopeSchema.parse({
      ...parsed.event,
      payload,
      eventId: `00000000-0000-4000-8000-${ingestSequence.toString(16).padStart(12, "0")}`,
      receivedAt: parsed.event.occurredAt,
      ingestSequence,
    });
  });
}

export interface OfflineOptions {
  readonly seed: number;
  readonly pace: Pace;
  /** Simulated duration. */
  readonly durationMs: number;
  readonly projectId?: string;
  readonly startAtMs?: number;
}

export interface OfflineRun {
  readonly events: StoredEnvelope[];
  readonly state: ProjectState;
  readonly stateHash: string;
}

export function runOffline(options: OfflineOptions): OfflineRun {
  const projectId = options.projectId ?? "demo";
  const steps = generateDemo({ ...options, projectId });
  const events = toStoredEvents(
    steps.flatMap((step) => step.events),
    projectId,
  );
  const state = replay(projectId, events);
  return { events, state, stateHash: projectStateHash(state) };
}
