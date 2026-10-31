// Loader for the event fixtures in this directory, for engine, CLI, and protocol tests.
//
// Each `<name>.jsonl` holds one input event per line (contracts/events.md "JSONL file format":
// blank lines and lines starting with `//` are ignored; line numbers are 1-based file lines).
// Each `<name>.expected.json` holds the hand-written result of ingesting it with POST
// /v1/events/batch into projects that already exist with head `startHead`, after first ingesting
// the fixtures listed in `after`, in order, into the same projects.
//
// Imports only Node built-ins, so it can be loaded from any package's tests without resolving
// workspace dependencies from this directory.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES_DIR = import.meta.dirname;

export const EVENT_FIXTURES = [
  "basic-two-agents.jsonl",
  "duplicates.jsonl",
  "conflicts.jsonl",
  "invalid.jsonl",
  "crew.jsonl",
] as const;
export type EventFixture = (typeof EVENT_FIXTURES)[number];

export type FixtureLine =
  | { line: number; ok: true; value: unknown }
  | { line: number; ok: false; error: string };

/** One expected per-line ingest result. A line that is not valid JSON is `invalid_envelope`. */
export type ExpectedResult = {
  line: number;
  /** Present when the line carried a valid one. */
  sourceEventId?: string;
  status: "accepted" | "duplicate" | "conflict" | "rejected";
  /** Accepted: the sequence assigned. Duplicate: the original's sequence. */
  ingestSequence?: number;
  /** Duplicate or conflict: the line holding the original event. */
  of?: { fixture: EventFixture; line: number };
  /** Rejected: the rejection code and, when one field is at fault, its dotted path. */
  code?: string;
  path?: string;
};

export type ExpectedIngest = {
  fixture: EventFixture;
  /** Projects that exist before ingest (`project add` plus the built-in `unsorted`). */
  knownProjects: string[];
  /** Head of every known project before ingest: 1, the `project.created` event. */
  startHead: number;
  /** Fixtures ingested first, in order, into the same projects. */
  after: EventFixture[];
  results: ExpectedResult[];
  summary: { accepted: number; duplicate: number; conflict: number; rejected: number };
};

/** Splits JSONL text into numbered entries, skipping blank and `//` comment lines. */
export function parseJsonl(text: string): FixtureLine[] {
  const entries: FixtureLine[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("//")) return;
    const line = index + 1;
    try {
      entries.push({ line, ok: true, value: JSON.parse(trimmed) });
    } catch (error) {
      entries.push({ line, ok: false, error: (error as Error).message });
    }
  });
  return entries;
}

export const fixturePath = (name: EventFixture): string => join(FIXTURES_DIR, name);

/** Every event line of a fixture, including malformed ones. */
export function loadFixture(name: EventFixture): FixtureLine[] {
  return parseJsonl(readFileSync(fixturePath(name), "utf8"));
}

/** The parsed events of a fixture; throws, naming the line, if any line is not JSON. */
export function loadEvents(name: EventFixture): unknown[] {
  return loadFixture(name).map((entry) => {
    if (!entry.ok) throw new Error(`${name}:${entry.line}: ${entry.error}`);
    return entry.value;
  });
}

/** The expected ingest results for a fixture. */
export function loadExpected(name: EventFixture): ExpectedIngest {
  const path = fixturePath(name).replace(/\.jsonl$/, ".expected.json");
  return JSON.parse(readFileSync(path, "utf8")) as ExpectedIngest;
}
