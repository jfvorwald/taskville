import { type IngestResult, storedEnvelopeSchema } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { IngestPipeline } from "../../src/ingest/index.ts";
import {
  EVENT_FIXTURES,
  type EventFixture,
  type ExpectedResult,
  loadExpected,
  loadFixture,
} from "../../../../fixtures/events/loader.ts";
import { addProject, fixedNow, useStorage } from "./helpers.ts";

// Golden test (M1.17): the engine's real ingest must reproduce every
// `*.expected.json` line for line, starting from the known projects at head 1.

const db = useStorage([]);

type Ingested = Map<string, IngestResult>;

/** Ingests one fixture as one batch; a line that is not JSON is sent as its raw text. */
function ingestFixture(pipeline: IngestPipeline, name: EventFixture, seen: Ingested): IngestResult[] {
  const lines = loadFixture(name);
  const batch = lines.map((entry) => (entry.ok ? entry.value : `malformed line ${entry.line}`));
  const { results } = pipeline.ingest(batch);
  lines.forEach((entry, i) => {
    const result = results[i];
    if (result) seen.set(`${name}:${entry.line}`, result);
  });
  return results;
}

function eventIdOf(result: IngestResult | undefined): string | undefined {
  return result && "eventId" in result ? result.eventId : undefined;
}

/** The engine's result, reduced to the fields an expected line states. */
function asExpected(line: number, result: IngestResult, seen: Ingested, expected: ExpectedResult) {
  const out: Record<string, unknown> = { line, status: result.status };
  if (result.sourceEventId !== undefined) out.sourceEventId = result.sourceEventId;
  if (result.status === "accepted" || result.status === "duplicate") {
    out.ingestSequence = result.ingestSequence;
  }
  if (result.status === "rejected") {
    out.code = result.error.code;
    if (result.error.path !== undefined) out.path = result.error.path;
  }
  if (expected.of) {
    const original = eventIdOf(seen.get(`${expected.of.fixture}:${expected.of.line}`));
    const pointsAt = result.status === "conflict" ? result.existingEventId : eventIdOf(result);
    if (original !== undefined && pointsAt === original) out.of = expected.of;
  }
  return out;
}

describe("golden fixtures through the real ingest", () => {
  for (const name of EVENT_FIXTURES) {
    it(`reproduces ${name.replace(".jsonl", ".expected.json")} line for line`, () => {
      const expected = loadExpected(name);
      const storage = db.storage();
      for (const id of expected.knownProjects) {
        if (storage.project(id) === undefined) addProject(storage, id);
        expect(storage.head(id)).toBe(expected.startHead);
      }
      const pipeline = new IngestPipeline({ storage, now: fixedNow });
      const seen: Ingested = new Map();
      for (const earlier of expected.after) ingestFixture(pipeline, earlier, seen);

      const results = ingestFixture(pipeline, name, seen);
      const lines = loadFixture(name);
      expect(results).toHaveLength(expected.results.length);
      const actual = expected.results.map((exp, i) => {
        const result = results[i];
        expect(lines[i]?.line).toBe(exp.line);
        if (!result) throw new Error(`no result for line ${exp.line}`);
        return asExpected(exp.line, result, seen, exp);
      });
      expect(actual).toEqual(expected.results);

      const counts = { accepted: 0, duplicate: 0, conflict: 0, rejected: 0 };
      for (const r of results) counts[r.status] += 1;
      expect(counts).toEqual(expected.summary);

      for (const id of expected.knownProjects) {
        for (const event of storage.events(id)) storedEnvelopeSchema.parse(event);
      }
    });
  }
});
