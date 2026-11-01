import { afterEach, describe, expect, it } from "vitest";
import {
  addProject,
  bootInProcess,
  type Engine,
  getJson,
  ingest,
  input,
  useDbPath,
} from "./helpers.ts";

// The timestamp grammar for `at`, `from` and `to` (M6.01 review round 3).
//
// Pinned contract: strict. A position timestamp is `YYYY-MM-DDTHH:MM[:SS[.fraction]]` followed by
// `Z` or a `+HH:MM` / `-HH:MM` offset, upper-case `T` and `Z`, and every field must be in range.
// Hour 24 (end of day), hour 25, minute 60, second 60, offsets beyond 23:59 or with minutes
// above 59, lower-case `t` or `z`, and a space for the `T` are 400 bad_request on all three
// parameters, never a quiet guess.

const dbPath = useDbPath();
let small: Engine | undefined;
afterEach(() => {
  small?.close();
  small = undefined;
});

const REJECTED = [
  "2026-01-01T24:00:00Z",
  "2026-01-01T24:00Z",
  "2026-01-01T24:00:00.000Z",
  "2026-01-01T25:00:00Z",
  "2026-01-01T00:60:00Z",
  "2026-01-01T00:00:60Z",
  "2026-01-01T00:00:00+25:00",
  "2026-01-01T00:00:00-25:00",
  "2026-01-01T00:00:00+99:00",
  "2026-01-01T00:00:00+02:60",
  "2026-01-01t00:00:00Z",
  "2026-01-01T00:00:00z",
  "2026-01-01 00:00:00Z",
  "2026-01-01 00:00:00+02:00",
];

const ACCEPTED = [
  "2026-01-01T00:00:00Z",
  "2026-01-01T23:59:59Z",
  "2026-01-01T23:59:59.999Z",
  "2026-01-01T00:00Z",
  "2026-01-01T12:00:00+05:30",
  "2026-01-01T12:00:00-08:00",
];

async function boot() {
  const booted = bootInProcess(dbPath());
  small = booted.engine;
  addProject(small.storage, "demo");
  await ingest(booted.app, [input("a1"), input("a2")]);
  return booted.app;
}

const paths = (value: string) => [
  ["state?at", `/v1/timelines/live:demo/state?at=${encodeURIComponent(value)}`],
  ["events?from", `/v1/timelines/live:demo/events?from=${encodeURIComponent(value)}`],
  ["events?to", `/v1/timelines/live:demo/events?to=${encodeURIComponent(value)}`],
];

describe("strict timestamp grammar", () => {
  it.each(REJECTED)("rejects %s as at, from and to", async (value) => {
    const app = await boot();
    for (const [name, path] of paths(value)) {
      const { status, body } = await getJson<{ error?: { code: string } }>(app, path as string);
      expect(status, `${name}=${value}`).toBe(400);
      expect(body.error?.code, `${name}=${value}`).toBe("bad_request");
    }
  });

  it.each(ACCEPTED)("control: accepts %s as at, from and to", async (value) => {
    const app = await boot();
    for (const [name, path] of paths(value)) {
      const { status } = await getJson(app, path as string);
      expect(status, `${name}=${value}`).toBe(200);
    }
  });
});
