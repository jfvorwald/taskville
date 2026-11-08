import { describe, expect, it } from "vitest";
import { StorageError } from "../../src/storage/index.ts";
import { envelope, HASH_A } from "../storage/helpers.ts";
import { PROJECT, useImportsEnv, zeroCounts } from "./helpers.ts";

// `storage.archives()` (M8.06): create, finish and read archives. The reads are what M8.07 builds
// the archive timelines on: list done archives per project, event count and first/last occurredAt,
// events by position range, the event at a position, and the greatest position with occurredAt at
// or before a timestamp. Positions are 1..n and gap-free; `envelope.ingestSequence` is the position.

const env = useImportsEnv();

const ARCHIVE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const END = "2026-11-08T09:05:00.000Z";

function at(minute: number): string {
  return `2026-11-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

function write(position: number, minute: number, sourceEventId = `c-${position}`) {
  return {
    contentHash: HASH_A,
    envelope: envelope(PROJECT, position, {
      sourceId: "git:test-repo",
      sourceEventId,
      occurredAt: at(minute),
      receivedAt: at(minute),
      provenance: "imported",
      type: "agent.connected",
    }),
  };
}

function newArchive(id = ARCHIVE, createdAt = "2026-11-08T09:00:00.000Z") {
  return env().storage.archives().create({
    id,
    projectId: PROJECT,
    kind: "git",
    label: "git: repo",
    root: env().root,
    createdAt,
  });
}

describe("archives storage", () => {
  it("creates a running archive and reads it back", () => {
    const created = newArchive();
    expect(created).toMatchObject({
      id: ARCHIVE,
      projectId: PROJECT,
      kind: "git",
      label: "git: repo",
      root: env().root,
      status: "running",
      createdAt: "2026-11-08T09:00:00.000Z",
      finishedAt: null,
      eventCount: 0,
      firstAt: null,
      lastAt: null,
      error: null,
    });
    expect(env().storage.archives().get(ARCHIVE)).toEqual(created);
    expect(env().storage.archives().get("missing")).toBeUndefined();
    expect(env().storage.archives().running(PROJECT)?.id).toBe(ARCHIVE);
  });

  it("refuses an archive for an unknown project", () => {
    expect(() =>
      env().storage.archives().create({
        id: ARCHIVE,
        projectId: "nope",
        kind: "git",
        label: "x",
        root: env().root,
        createdAt: END,
      }),
    ).toThrow();
  });

  it("completes with events at gap-free positions and summarizes them", () => {
    newArchive();
    const counts = { ...zeroCounts(), read: 3, imported: 3 };
    const done = env()
      .storage.archives()
      .complete(ARCHIVE, {
        events: [write(1, 1), write(2, 3), write(3, 7)],
        counts,
        finishedAt: END,
      });
    expect(done).toMatchObject({
      status: "done",
      eventCount: 3,
      firstAt: at(1),
      lastAt: at(7),
      finishedAt: END,
      counts,
    });
    expect(env().storage.archives().get(ARCHIVE)).toEqual(done);
    expect(env().storage.archives().running(PROJECT)).toBeUndefined();
  });

  it("reads events by position range, and the event at a position", () => {
    newArchive();
    env()
      .storage.archives()
      .complete(ARCHIVE, {
        events: [write(1, 1), write(2, 3), write(3, 7), write(4, 9)],
        counts: zeroCounts(),
        finishedAt: END,
      });
    const archives = env().storage.archives();
    expect(archives.events(ARCHIVE, 2, 3).map((e) => e.ingestSequence)).toEqual([2, 3]);
    expect(archives.events(ARCHIVE, 1, 4).map((e) => e.sourceEventId)).toEqual([
      "c-1",
      "c-2",
      "c-3",
      "c-4",
    ]);
    expect(archives.events(ARCHIVE, 4, 99).map((e) => e.ingestSequence)).toEqual([4]);
    expect(archives.events(ARCHIVE, 5, 9)).toEqual([]);
    const second = archives.eventAt(ARCHIVE, 2);
    expect(second).toMatchObject({
      ingestSequence: 2,
      sourceEventId: "c-2",
      occurredAt: at(3),
      provenance: "imported",
      projectId: PROJECT,
    });
    expect(archives.eventAt(ARCHIVE, 5)).toBeUndefined();
    expect(archives.eventAt(ARCHIVE, 0)).toBeUndefined();
    expect(archives.eventAt("missing", 1)).toBeUndefined();
  });

  it("finds the greatest position with occurredAt at or before a timestamp", () => {
    newArchive();
    env()
      .storage.archives()
      .complete(ARCHIVE, {
        events: [write(1, 1), write(2, 3), write(3, 3, "c-3"), write(4, 9)],
        counts: zeroCounts(),
        finishedAt: END,
      });
    const archives = env().storage.archives();
    expect(archives.positionAtOrBefore(ARCHIVE, at(0))).toBe(0);
    expect(archives.positionAtOrBefore(ARCHIVE, at(1))).toBe(1);
    expect(archives.positionAtOrBefore(ARCHIVE, at(2))).toBe(1);
    // Two events share minute 3: the greatest position wins.
    expect(archives.positionAtOrBefore(ARCHIVE, at(3))).toBe(3);
    expect(archives.positionAtOrBefore(ARCHIVE, at(8))).toBe(3);
    expect(archives.positionAtOrBefore(ARCHIVE, at(59))).toBe(4);
  });

  it("lists done archives per project, newest first, and no others", () => {
    newArchive(ARCHIVE, "2026-11-08T09:00:00.000Z");
    newArchive(OTHER, "2026-11-08T09:30:00.000Z");
    const failed = "33333333-3333-4333-8333-333333333333";
    const running = "44444444-4444-4444-8444-444444444444";
    newArchive(failed, "2026-11-08T09:40:00.000Z");
    newArchive(running, "2026-11-08T09:50:00.000Z");
    const archives = env().storage.archives();
    archives.complete(ARCHIVE, { events: [write(1, 1)], counts: zeroCounts(), finishedAt: END });
    archives.complete(OTHER, { events: [write(1, 2)], counts: zeroCounts(), finishedAt: END });
    archives.fail(failed, {
      error: { code: "importer_failed", message: "The importer failed" },
      counts: zeroCounts(),
      finishedAt: END,
    });
    expect(archives.listDone(PROJECT).map((a) => a.id)).toEqual([OTHER, ARCHIVE]);
    expect(archives.listDone("unsorted")).toEqual([]);
    expect(archives.get(failed)).toMatchObject({
      status: "failed",
      error: { code: "importer_failed", message: "The importer failed" },
      eventCount: 0,
    });
  });

  it("cancels without events", () => {
    newArchive();
    const cancelled = env()
      .storage.archives()
      .cancel(ARCHIVE, { counts: zeroCounts(), finishedAt: END });
    expect(cancelled).toMatchObject({ status: "cancelled", eventCount: 0, finishedAt: END });
    expect(env().storage.archives().events(ARCHIVE, 1, 10)).toEqual([]);
  });

  it("is immutable once finished", () => {
    newArchive();
    const archives = env().storage.archives();
    archives.complete(ARCHIVE, { events: [write(1, 1)], counts: zeroCounts(), finishedAt: END });
    expect(() =>
      archives.complete(ARCHIVE, { events: [write(1, 2)], counts: zeroCounts(), finishedAt: END }),
    ).toThrow(StorageError);
    expect(() => archives.cancel(ARCHIVE, { counts: zeroCounts(), finishedAt: END })).toThrow(
      StorageError,
    );
    expect(archives.get(ARCHIVE)?.status).toBe("done");
    expect(archives.events(ARCHIVE, 1, 9)).toHaveLength(1);
  });

  it("writes all events in one transaction: a bad event leaves the archive running and empty", () => {
    newArchive();
    const archives = env().storage.archives();
    // Position 3 is skipped: the positions must be 1..n in the order given.
    expect(() =>
      archives.complete(ARCHIVE, {
        events: [write(1, 1), write(2, 2), write(4, 3)],
        counts: zeroCounts(),
        finishedAt: END,
      }),
    ).toThrow(StorageError);
    // A repeated source key is refused too.
    expect(() =>
      archives.complete(ARCHIVE, {
        events: [write(1, 1, "same"), write(2, 2, "same")],
        counts: zeroCounts(),
        finishedAt: END,
      }),
    ).toThrow();
    expect(archives.get(ARCHIVE)?.status).toBe("running");
    expect(archives.events(ARCHIVE, 1, 10)).toEqual([]);
  });

  it("never touches the live log, head or projection", () => {
    const before = {
      head: env().storage.head(PROJECT),
      events: [...env().storage.events(PROJECT)],
      projection: env().storage.projection(PROJECT),
    };
    newArchive();
    env()
      .storage.archives()
      .complete(ARCHIVE, {
        events: [write(1, 1), write(2, 2)],
        counts: zeroCounts(),
        finishedAt: END,
      });
    expect(env().storage.head(PROJECT)).toBe(before.head);
    expect([...env().storage.events(PROJECT)]).toEqual(before.events);
    expect(env().storage.projection(PROJECT)).toEqual(before.projection);
  });

  it("fails every archive left running by a dead engine", () => {
    newArchive();
    const count = env().storage.archives().failInterrupted(END);
    expect(count).toBe(1);
    expect(env().storage.archives().get(ARCHIVE)).toMatchObject({
      status: "failed",
      finishedAt: END,
      error: { code: "interrupted" },
    });
    expect(env().storage.archives().failInterrupted(END)).toBe(0);
  });
});
