import { describe, expect, it } from "vitest";
import {
  badPayloadEvent,
  commitEvent,
  fakeImporter,
  gatedImporter,
  makeDir,
  makeJobs,
  makeLink,
  PROJECT,
  refusalCode,
  unknownTypeEvent,
  useImportsEnv,
  zeroCounts,
} from "./helpers.ts";

// The import job runner (M8.06): runs an Importer off the request, validates, sorts, assigns
// engine IDs and writes one archive in one transaction.

const env = useImportsEnv();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function request() {
  return { projectId: PROJECT, kind: "git" as const, root: env().root };
}

function readAll(archiveId: string) {
  return env().storage.archives().events(archiveId, 1, 1_000_000);
}

describe("import job runner: ordering and storage", () => {
  const events = [
    commitEvent("a", "2026-11-01T10:00:03Z", { sourceSequence: 1 }),
    commitEvent("z", "2026-11-01T10:00:01Z"),
    commitEvent("m", "2026-11-01T10:00:01Z"),
    commitEvent("d", "2026-11-01T10:00:01Z", { sourceSequence: 5 }),
    commitEvent("e", "2026-11-01T10:00:01Z", { sourceSequence: 2 }),
    commitEvent("f", "2026-11-01T10:00:02Z"),
  ];

  it("reads events back sorted by occurredAt, sourceSequence (absent first), sourceEventId", async () => {
    // Yielded out of order, across two batches.
    const importer = fakeImporter([{ events: events.slice(0, 3) }, { events: events.slice(3) }]);
    const jobs = makeJobs(env(), [importer]);
    const { importId, archiveId, status } = jobs.start(request());
    expect(status).toBe("running");
    expect(importId).toBe(archiveId);
    expect(archiveId).toMatch(UUID);

    const finished = await jobs.settled(importId);
    expect(finished).toMatchObject({
      importId,
      archiveId,
      projectId: PROJECT,
      kind: "git",
      status: "done",
      counts: { read: 6, imported: 6, skipped: 0, malformed: 0 },
    });
    expect(finished.error).toBeUndefined();

    const stored = readAll(archiveId);
    expect(stored.map((e) => e.sourceEventId)).toEqual(["m", "z", "e", "d", "f", "a"]);
    expect(stored.map((e) => e.ingestSequence)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const event of stored) {
      expect(event.provenance).toBe("imported");
      expect(event.eventId).toMatch(UUID);
      expect(event.projectId).toBe(PROJECT);
    }
    expect(new Set(stored.map((e) => e.eventId)).size).toBe(6);

    const record = env().storage.archives().get(archiveId);
    expect(record).toMatchObject({
      status: "done",
      kind: "git",
      projectId: PROJECT,
      root: env().root,
      eventCount: 6,
      firstAt: "2026-11-01T10:00:01Z",
      lastAt: "2026-11-01T10:00:03Z",
    });
  });

  it("orders by instant, not by timestamp text, across UTC offsets", async () => {
    const importer = fakeImporter([
      {
        events: [
          // 10:30Z is later, though its text sorts before "12:00:00+02:00".
          commitEvent("later", "2026-11-01T10:30:00Z"),
          // 12:00+02:00 is 10:00Z: earlier by the clock.
          commitEvent("earlier", "2026-11-01T12:00:00+02:00"),
        ],
      },
    ]);
    const jobs = makeJobs(env(), [importer]);
    const { importId, archiveId } = jobs.start(request());
    await jobs.settled(importId);
    expect(readAll(archiveId).map((e) => e.sourceEventId)).toEqual(["earlier", "later"]);
  });

  it("hands the importer the project, the real path of the root, and a signal", async () => {
    const link = makeLink(env(), "link", env().root);
    const seen: { projectId: string; root: string; aborted: boolean }[] = [];
    const importer = fakeImporter([{ events: [commitEvent("a", "2026-11-01T10:00:00Z")] }], {
      onRun: (context) =>
        seen.push({
          projectId: context.projectId,
          root: context.root,
          aborted: context.signal.aborted,
        }),
    });
    const jobs = makeJobs(env(), [importer]);
    const { importId } = jobs.start({ ...request(), root: link });
    await jobs.settled(importId);
    expect(seen).toEqual([{ projectId: PROJECT, root: env().root, aborted: false }]);
  });

  it("counts a repeated source key with different content as a conflict, keeping the first", async () => {
    const importer = fakeImporter(
      [
        {
          events: [
            commitEvent("dup", "2026-11-01T10:00:02Z"),
            commitEvent("dup", "2026-11-01T10:00:01Z"),
            commitEvent("ok", "2026-11-01T10:00:03Z"),
          ],
        },
      ],
      { final: { read: 3, imported: 3, skipped: 0, malformed: 0 } },
    );
    const jobs = makeJobs(env(), [importer]);
    const { importId, archiveId } = jobs.start(request());
    const finished = await jobs.settled(importId);
    expect(finished.status).toBe("done");
    expect(finished.counts).toMatchObject({
      imported: 2,
      skipped: 0,
      malformed: 1,
      malformedByCode: { conflict: 1 },
    });
    expect(readAll(archiveId).map((e) => e.sourceEventId)).toEqual(["dup", "ok"]);
    expect(readAll(archiveId)[0]?.occurredAt).toBe("2026-11-01T10:00:02Z");
  });

  it("imports again into a new archive; the first stays as it was", async () => {
    const importer = fakeImporter([{ events: [commitEvent("a", "2026-11-01T10:00:00Z")] }]);
    const jobs = makeJobs(env(), [importer]);
    const first = jobs.start(request());
    await jobs.settled(first.importId);
    const second = jobs.start(request());
    await jobs.settled(second.importId);
    expect(second.archiveId).not.toBe(first.archiveId);
    expect(readAll(first.archiveId)).toHaveLength(1);
    expect(readAll(second.archiveId)).toHaveLength(1);
    // Same source key, different engine event IDs, in separate archives.
    expect(readAll(first.archiveId)[0]?.eventId).not.toBe(readAll(second.archiveId)[0]?.eventId);
    expect(
      env()
        .storage.archives()
        .listDone(PROJECT)
        .map((a) => a.id),
    ).toEqual([second.archiveId, first.archiveId]);
  });
});

describe("import job runner: malformed events and the cap", () => {
  it("counts malformed events with their codes and does not store them", async () => {
    const importer = fakeImporter(
      [
        {
          events: [
            commitEvent("a", "2026-11-01T10:00:01Z"),
            unknownTypeEvent("bad-1"),
            badPayloadEvent("bad-2"),
            unknownTypeEvent("bad-3"),
            commitEvent("b", "2026-11-01T10:00:02Z"),
          ],
        },
      ],
      // The importer itself counted one unparseable source line.
      { final: { read: 6, imported: 5, skipped: 0, malformed: 1 } },
    );
    const jobs = makeJobs(env(), [importer]);
    const { importId, archiveId } = jobs.start(request());
    const finished = await jobs.settled(importId);
    expect(finished.status).toBe("done");
    expect(finished.counts).toMatchObject({
      read: 6,
      imported: 2,
      skipped: 0,
      // 3 invalid events the runner rejected + 1 the importer reported.
      malformed: 4,
      malformedByCode: { unknown_type: 2, invalid_payload: 1 },
    });
    expect(finished.counts.truncated).toBeFalsy();
    expect(readAll(archiveId).map((e) => e.sourceEventId)).toEqual(["a", "b"]);
    expect(env().storage.archives().get(archiveId)?.eventCount).toBe(2);
  });

  it("stops at the cap with status done, the rest skipped and truncated: true", async () => {
    const all = Array.from({ length: 8 }, (_, i) =>
      commitEvent(`c-${i}`, `2026-11-01T10:00:0${i}Z`),
    );
    const importer = fakeImporter(all.map((event) => ({ events: [event] })));
    // One event per batch: the rest of a batch that crosses the cap is still counted as skipped.
    const jobs = makeJobs(env(), [importer], { maxEvents: 5 });
    const { importId, archiveId } = jobs.start(request());
    const finished = await jobs.settled(importId);
    expect(finished.status).toBe("done");
    // The importer is stopped at the first event past the cap, so only that one is skipped
    // (events are one per batch here).
    expect(finished.counts).toMatchObject({
      imported: 5,
      skipped: 1,
      malformed: 0,
      truncated: true,
    });
    // The first five yielded are kept.
    expect(readAll(archiveId).map((e) => e.sourceEventId)).toEqual([
      "c-0",
      "c-1",
      "c-2",
      "c-3",
      "c-4",
    ]);
    expect(env().storage.archives().get(archiveId)).toMatchObject({
      status: "done",
      eventCount: 5,
    });
  });

  it("is not truncated exactly at the cap", async () => {
    const all = Array.from({ length: 5 }, (_, i) =>
      commitEvent(`c-${i}`, `2026-11-01T10:00:0${i}Z`),
    );
    const jobs = makeJobs(env(), [fakeImporter([{ events: all }])], { maxEvents: 5 });
    const { importId } = jobs.start(request());
    const finished = await jobs.settled(importId);
    expect(finished.counts).toMatchObject({ imported: 5, skipped: 0 });
    expect(finished.counts.truncated).toBeFalsy();
  });
});

describe("import job runner: failure and cancel", () => {
  it("leaves a failed archive with an error code and no events when the importer throws", async () => {
    const importer = {
      kind: "git" as const,
      async *run() {
        yield { events: [commitEvent("a", "2026-11-01T10:00:00Z")] };
        throw new Error("boom: secret source text /Users/someone/private");
      },
    };
    const jobs = makeJobs(env(), [importer]);
    const { importId, archiveId } = jobs.start(request());
    const finished = await jobs.settled(importId);
    expect(finished.status).toBe("failed");
    expect(finished.error?.code).toBe("importer_failed");
    expect(finished.finishedAt).toBeDefined();
    // The error never carries source text.
    expect(JSON.stringify(finished)).not.toContain("secret source text");
    expect(JSON.stringify(finished)).not.toContain("/Users/someone");
    expect(readAll(archiveId)).toEqual([]);
    expect(env().storage.archives().get(archiveId)).toMatchObject({
      status: "failed",
      eventCount: 0,
      error: { code: "importer_failed" },
    });
    expect(env().storage.archives().listDone(PROJECT)).toEqual([]);
    // The project is free for another import.
    expect(env().storage.archives().running(PROJECT)).toBeUndefined();
  });

  it("aborts running jobs on engine shutdown and leaves cancelled archives with no events", async () => {
    const gate = gatedImporter({ events: [commitEvent("a", "2026-11-01T10:00:00Z")] });
    const jobs = makeJobs(env(), [gate.importer]);
    const { importId, archiveId } = jobs.start(request());
    await gate.started;
    expect(gate.contexts[0]?.signal.aborted).toBe(false);

    await jobs.close();

    expect(gate.contexts[0]?.signal.aborted).toBe(true);
    expect(jobs.status(importId)).toMatchObject({ status: "cancelled" });
    expect(env().storage.archives().get(archiveId)).toMatchObject({
      status: "cancelled",
      eventCount: 0,
    });
    expect(env().storage.archives().get(archiveId)?.finishedAt).not.toBeNull();
    expect(readAll(archiveId)).toEqual([]);
  });

  it("exposes progress while running", async () => {
    const gate = gatedImporter({ events: [commitEvent("a", "2026-11-01T10:00:00Z")] });
    const jobs = makeJobs(env(), [gate.importer]);
    const { importId } = jobs.start(request());
    expect(jobs.status(importId)).toMatchObject({
      status: "running",
      counts: zeroCounts(),
      startedAt: "2026-11-08T09:00:00.000Z",
    });
    await gate.started;
    expect(jobs.status(importId)).toMatchObject({
      status: "running",
      counts: { read: 3, imported: 3 },
    });
    expect(jobs.status(importId)?.finishedAt).toBeUndefined();
    gate.release();
    const finished = await jobs.settled(importId);
    expect(finished.status).toBe("done");
    expect(finished.finishedAt).toBeDefined();
    await jobs.close();
  });

  it("marks archives left running by a dead engine as failed when jobs start", () => {
    const stale = "55555555-5555-4555-8555-555555555555";
    env().storage.archives().create({
      id: stale,
      projectId: PROJECT,
      kind: "git",
      label: "git: repo",
      root: env().root,
      createdAt: "2026-11-07T09:00:00.000Z",
    });
    makeJobs(env(), [fakeImporter([])]);
    expect(env().storage.archives().get(stale)).toMatchObject({
      status: "failed",
      error: { code: "interrupted" },
    });
  });
});

describe("import job runner: refusals", () => {
  it("refuses an unknown kind, an unknown project and a root that is not configured", () => {
    const jobs = makeJobs(env(), [fakeImporter([], { kind: "git" })]);
    expect(refusalCode(() => jobs.start({ ...request(), kind: "transcripts" }))).toBe(
      "unknown_import_kind",
    );
    expect(refusalCode(() => jobs.start({ ...request(), projectId: "nope" }))).toBe(
      "unknown_project",
    );
    const other = makeDir(env(), "other");
    expect(refusalCode(() => jobs.start({ ...request(), root: other }))).toBe(
      "root_not_configured",
    );
    // `..` is resolved before it is compared.
    expect(refusalCode(() => jobs.start({ ...request(), root: `${env().root}/../other` }))).toBe(
      "root_not_configured",
    );
    expect(refusalCode(() => jobs.start({ ...request(), root: `${env().dir}/missing` }))).toBe(
      "root_not_configured",
    );
    // Nothing was created for any refusal.
    expect(env().storage.archives().running(PROJECT)).toBeUndefined();
    expect(env().storage.archives().listDone(PROJECT)).toEqual([]);
  });

  it("refuses a second import while one runs, then allows one after it finishes", async () => {
    const gate = gatedImporter({ events: [commitEvent("a", "2026-11-01T10:00:00Z")] });
    const jobs = makeJobs(env(), [gate.importer]);
    const first = jobs.start(request());
    expect(refusalCode(() => jobs.start(request()))).toBe("import_running");
    gate.release();
    await jobs.settled(first.importId);
    expect(refusalCode(() => jobs.start(request()))).toBeUndefined();
    await jobs.close();
  });
});

describe("import job runner: the live log", () => {
  it("leaves the live head, events and projection unchanged", async () => {
    const before = {
      head: env().storage.head(PROJECT),
      events: [...env().storage.events(PROJECT)],
      projection: env().storage.projection(PROJECT),
      unsortedHead: env().storage.head("unsorted"),
    };
    const importer = fakeImporter([
      {
        events: [
          commitEvent("a", "2026-11-01T10:00:00Z"),
          commitEvent("b", "2026-11-01T10:00:01Z"),
        ],
      },
    ]);
    const jobs = makeJobs(env(), [importer]);
    const { importId, archiveId } = jobs.start(request());
    await jobs.settled(importId);
    expect(readAll(archiveId)).toHaveLength(2);
    expect(env().storage.head(PROJECT)).toBe(before.head);
    expect([...env().storage.events(PROJECT)]).toEqual(before.events);
    expect(env().storage.projection(PROJECT)).toEqual(before.projection);
    expect(env().storage.head("unsorted")).toBe(before.unsortedHead);
  });
});
