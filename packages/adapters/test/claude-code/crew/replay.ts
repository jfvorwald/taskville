import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CrewEvent, mapCrewHook } from "../../../src/claude-code/crew/index.ts";

// Replays a recorded S-2 hook stream (fixtures/claude-code/{subagent,team}) through the crew
// mapper, one hook at a time and in receive order, as the engine will.

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "..", "fixtures", "claude-code");
const BASE_MS = Date.UTC(2026, 9, 30, 12, 0, 0);

export const PROJECT = "proj-crew";

export interface Line {
  seq: number;
  input: Record<string, unknown>;
  receivedAt: string;
  sourceEventId: string;
}

export function readFixture(name: string): Line[] {
  const text = readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const { seq, offset_ms, input } = JSON.parse(l) as {
        seq: number;
        offset_ms: number;
        input: Record<string, unknown>;
      };
      return {
        seq,
        input,
        receivedAt: new Date(BASE_MS + Math.round(offset_ms)).toISOString(),
        sourceEventId: `${name.replace("/", "-")}-${seq}`,
      };
    });
}

export interface Mapped {
  seq: number;
  hook: string;
  events: CrewEvent[];
  ignored?: string;
}

export function replay(name: string): Mapped[] {
  return readFixture(name).map((line) => {
    const result = mapCrewHook(line.input, {
      projectId: PROJECT,
      sourceEventId: line.sourceEventId,
      receivedAt: line.receivedAt,
      late: false,
    });
    return {
      seq: line.seq,
      hook: String(line.input.hook_event_name),
      events: result.events,
      ...(result.ignored === undefined ? {} : { ignored: result.ignored }),
    };
  });
}

export const allEvents = (mapped: Mapped[]): CrewEvent[] => mapped.flatMap((m) => m.events);
export const at = (mapped: Mapped[], seq: number): Mapped => {
  const m = mapped.find((x) => x.seq === seq);
  if (m === undefined) throw new Error(`no seq ${seq}`);
  return m;
};
