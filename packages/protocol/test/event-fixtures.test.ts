import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import {
  EVENT_FIXTURES,
  type EventFixture,
  type ExpectedResult,
  loadEvents,
  loadExpected,
  loadFixture,
  parseJsonl,
} from "../../../fixtures/events/loader.ts";
import {
  type IngestError,
  type InputEvent,
  idSchema,
  parseInputEvent,
  producerPolicyViolation,
  REJECTION_CODES,
} from "../src/index.ts";

// Golden tests for fixtures/events (M1.17). This file lives in the protocol package only because
// Vitest discovers tests under packages/*/test; the fixtures and loader live in fixtures/events.
//
// `simulateIngest` is a reference model of ingest without storage: protocol validation, producer
// policy, the project registry, and dedupe on (projectId, sourceId, sourceEventId) with
// same-content duplicates and different-content conflicts (ARCHITECTURE.md 7.2). Each fixture's
// `.expected.json` is written by hand; the model must reproduce it line for line.

type Seen = { event: InputEvent; fixture: EventFixture; line: number; ingestSequence: number };

function rejection(raw: unknown, line: number, error: IngestError): ExpectedResult {
  const sourceEventId =
    typeof raw === "object" && raw !== null && "sourceEventId" in raw
      ? idSchema.safeParse(raw.sourceEventId)
      : undefined;
  return {
    line,
    ...(sourceEventId?.success ? { sourceEventId: sourceEventId.data } : {}),
    status: "rejected",
    code: error.code,
    ...(error.path === undefined ? {} : { path: error.path }),
  };
}

function simulateIngest(fixture: EventFixture): ExpectedResult[] {
  const expected = loadExpected(fixture);
  const known = new Set(expected.knownProjects);
  const heads = new Map<string, number>();
  const seen = new Map<string, Seen>();

  const ingest = (name: EventFixture): ExpectedResult[] =>
    loadFixture(name).map((entry): ExpectedResult => {
      if (!entry.ok) {
        return { line: entry.line, status: "rejected", code: "invalid_envelope" };
      }
      const parsed = parseInputEvent(entry.value);
      if (!parsed.ok) return rejection(entry.value, entry.line, parsed.error);
      const event = parsed.event;
      const violation = producerPolicyViolation(event);
      if (violation !== undefined) return rejection(entry.value, entry.line, violation);
      if (!known.has(event.projectId)) {
        return rejection(entry.value, entry.line, {
          code: "unknown_project",
          path: "projectId",
          message: "never added",
        });
      }
      const key = JSON.stringify([event.projectId, event.sourceId, event.sourceEventId]);
      const original = seen.get(key);
      const base = { line: entry.line, sourceEventId: event.sourceEventId };
      if (original !== undefined) {
        const of = { fixture: original.fixture, line: original.line };
        return isDeepStrictEqual(original.event, event)
          ? { ...base, status: "duplicate", ingestSequence: original.ingestSequence, of }
          : { ...base, status: "conflict", of };
      }
      const ingestSequence = (heads.get(event.projectId) ?? expected.startHead) + 1;
      heads.set(event.projectId, ingestSequence);
      seen.set(key, { event, fixture: name, line: entry.line, ingestSequence });
      return { ...base, status: "accepted", ingestSequence };
    });

  for (const prior of expected.after) ingest(prior);
  return ingest(fixture);
}

describe("parseJsonl", () => {
  it("numbers lines from 1 and skips blank and // comment lines", () => {
    const lines = parseJsonl('// header\n\n{"a":1}\n   \n  // indented comment\n[2]\n');
    expect(lines).toEqual([
      { line: 3, ok: true, value: { a: 1 } },
      { line: 6, ok: true, value: [2] },
    ]);
  });

  it("accepts CRLF line endings", () => {
    expect(parseJsonl('{"a":1}\r\n{"b":2}\r\n')).toEqual([
      { line: 1, ok: true, value: { a: 1 } },
      { line: 2, ok: true, value: { b: 2 } },
    ]);
  });

  it("reports a malformed line instead of throwing", () => {
    const [entry] = parseJsonl("{not json");
    expect(entry?.ok).toBe(false);
    expect(entry?.line).toBe(1);
    if (entry !== undefined && !entry.ok) expect(entry.error.length).toBeGreaterThan(0);
  });
});

describe("loader", () => {
  it("lists every fixture", () => {
    expect([...EVENT_FIXTURES].sort()).toEqual(
      [
        "basic-two-agents.jsonl",
        "conflicts.jsonl",
        "crew.jsonl",
        "duplicates.jsonl",
        "invalid.jsonl",
      ].sort(),
    );
  });

  it("returns the events of a well-formed fixture", () => {
    const events = loadEvents("basic-two-agents.jsonl");
    expect(events).toHaveLength(12);
  });

  it("refuses to return events of a fixture with a malformed line", () => {
    expect(() => loadEvents("invalid.jsonl")).toThrow(/invalid\.jsonl:\d+/);
  });
});

describe.each(EVENT_FIXTURES)("%s", (fixture) => {
  const expected = loadExpected(fixture);

  it("matches its expected per-line results", () => {
    expect(simulateIngest(fixture)).toEqual(expected.results);
  });

  it("has one result per event line and a matching summary", () => {
    expect(expected.results.map((r) => r.line)).toEqual(loadFixture(fixture).map((e) => e.line));
    const count = (status: ExpectedResult["status"]) =>
      expected.results.filter((r) => r.status === status).length;
    expect(expected.summary).toEqual({
      accepted: count("accepted"),
      duplicate: count("duplicate"),
      conflict: count("conflict"),
      rejected: count("rejected"),
    });
  });

  it("uses fixed timestamps", () => {
    for (const entry of loadFixture(fixture)) {
      if (!entry.ok) continue;
      const value = entry.value as { occurredAt?: unknown };
      if (typeof value.occurredAt === "string") {
        expect(value.occurredAt).toMatch(/^2026-10-30T/);
      }
    }
  });
});

describe("fixture coverage", () => {
  it("basic-two-agents matches the quickstart: 12 accepted, then 12 duplicates", () => {
    expect(loadExpected("basic-two-agents.jsonl").summary).toEqual({
      accepted: 12,
      duplicate: 0,
      conflict: 0,
      rejected: 0,
    });
    const agents = new Set(
      loadEvents("basic-two-agents.jsonl")
        .map((e) => (e as { type: string; agentId?: string }).agentId)
        .filter((id) => id !== undefined),
    );
    expect(agents.size).toBe(2);
  });

  it("invalid covers every rejection code", () => {
    const codes = new Set(loadExpected("invalid.jsonl").results.map((r) => r.code));
    expect([...codes].sort()).toEqual([...REJECTION_CODES].sort());
    expect(loadExpected("invalid.jsonl").summary.accepted).toBe(0);
  });

  it("duplicates and conflicts each exercise their status", () => {
    expect(loadExpected("duplicates.jsonl").summary.duplicate).toBeGreaterThan(0);
    expect(loadExpected("conflicts.jsonl").summary.conflict).toBeGreaterThan(0);
    expect(loadExpected("conflicts.jsonl").after).toEqual(["basic-two-agents.jsonl"]);
  });

  it("crew has a subagent with a parent, a nested subagent, and a team with a teammate", () => {
    const events = loadEvents("crew.jsonl").map((raw) => {
      const parsed = parseInputEvent(raw);
      if (!parsed.ok) throw new Error(parsed.error.message);
      return parsed.event;
    });
    const registered = events.flatMap((e) => (e.type === "agent.registered" ? [e] : []));
    const kinds = new Set(registered.map((e) => e.payload.kind));
    expect([...kinds].sort()).toEqual(["lead", "session", "subagent", "teammate"]);
    const parents = registered.flatMap((e) =>
      e.payload.parentAgentId === undefined ? [] : [[e.agentId, e.payload.parentAgentId]],
    );
    expect(parents.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === "team.started")).toBe(true);
    expect(events.some((e) => e.type === "team.ended")).toBe(true);
    expect(events.some((e) => e.type === "agent.finished")).toBe(true);
  });
});
