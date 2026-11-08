import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { InputEventWire } from "@taskville/protocol";
import { describe, expect, it, vi } from "vitest";
import { openEvidenceStore } from "../../src/evidence/index.ts";
import type { ImportBatch, ImportContext, Importer } from "../../src/importers/index.ts";
import { addProject } from "../ingest/helpers.ts";
import {
  commitEvent,
  fakeImporter,
  gatedImporter,
  makeJobs,
  PROJECT,
  refusalCode,
  useImportsEnv,
} from "./helpers.ts";

// Review-fix round for M8.06 (roborev 7422 and the security review). New contract pinned here:
//
//   ImportJobsOptions (all optional, all injectable):
//     maxEventBytes          default 64 KB: serialized event over it is malformed `payload_too_large`
//     maxEvidenceItemBytes   raw JSON bytes of one evidence item; over it the item is dropped
//     maxEvidenceBytes       per-import raw evidence budget; items past it are dropped
//     closeTimeoutMs         close() gives up waiting on an importer that ignores the signal
//   ArchiveCounts / ImportStatus.counts gain `evidenceDropped` (set when > 0), counting evidence
//     items dropped by the item limit, the budget, or because no kept event refers to them.
//   ImportRefusalCode gains `engine_closing` (start after close), mapped to HTTP 503 by the route.
//   Evidence scoping: ImportJobs calls `evidence.store(projectId, items, archiveId)` and the store
//     reads archive evidence with `store.get(projectId, toolCallId, archiveId)`. `get` without an
//     archiveId is the live read and never returns archive bodies; the archive read never
//     returns live bodies. Evidence reaches the store only after the archive is complete.
//   Only one import runs engine-wide: a second start for any project is `import_running`.

const env = useImportsEnv();

function request() {
  return { projectId: PROJECT, kind: "git" as const, root: env().root };
}

function toolEvent(
  sourceEventId: string,
  toolCallId: string,
  at = "2026-11-01T10:00:00Z",
  overrides: Record<string, unknown> = {},
): InputEventWire {
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    sourceId: "transcript:s1",
    sourceEventId,
    occurredAt: at,
    type: "tool_call.started",
    payload: { toolCallId, toolName: "Bash" },
    provenance: "imported",
    ...overrides,
  } as InputEventWire;
}

function transcriptsImporter(batches: readonly ImportBatch[]): Importer {
  return fakeImporter(batches, { kind: "transcripts" });
}

function transcriptsRequest() {
  return { projectId: PROJECT, kind: "transcripts" as const, root: env().root };
}

/** Collects unhandled rejections raised while `fn` runs and a few turns after. */
async function unhandledDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await fn();
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return seen;
}

describe("conflicting repeated source keys (roborev 7422)", () => {
  it("skips an identical repeat of a source key", async () => {
    const a = commitEvent("dup", "2026-11-01T10:00:00Z");
    const jobs = makeJobs(env(), [fakeImporter([{ events: [a, structuredClone(a)] }])]);
    const { importId } = jobs.start(request());
    const finished = await jobs.settled(importId);
    expect(finished.status).toBe("done");
    expect(finished.counts).toMatchObject({ imported: 1, skipped: 1, malformed: 0 });
    expect(finished.counts.malformedByCode?.conflict).toBeUndefined();
  });

  it("counts a repeat with different content as malformed conflict, keeping the first", async () => {
    const first = commitEvent("dup", "2026-11-01T10:00:02Z");
    const second = commitEvent("dup", "2026-11-01T10:00:01Z"); // different sha and time
    const jobs = makeJobs(env(), [fakeImporter([{ events: [first, second] }])]);
    const { importId, archiveId } = jobs.start(request());
    const finished = await jobs.settled(importId);
    expect(finished.status).toBe("done");
    expect(finished.counts).toMatchObject({
      imported: 1,
      skipped: 0,
      malformed: 1,
      malformedByCode: { conflict: 1 },
    });
    const stored = env().storage.archives().events(archiveId, 1, 100);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.occurredAt).toBe("2026-11-01T10:00:02Z");
  });
});

describe("staged, scoped, bounded evidence", () => {
  function openStore() {
    return openEvidenceStore(join(env().dir, "evidence.db"), { now: () => new Date() });
  }

  it("stores evidence only for kept events", async () => {
    const store = openStore();
    try {
      const batch: ImportBatch = {
        events: [
          toolEvent("e-kept", "tc-kept", "2026-11-01T10:00:01Z"),
          toolEvent("e-dup", "tc-kept", "2026-11-01T10:00:01Z"),
          toolEvent("e-bad", "tc-bad", "2026-11-01T10:00:02Z", {
            payload: { toolCallId: "tc-bad", toolName: "" },
          }),
          toolEvent("e-c", "tc-c-first", "2026-11-01T10:00:03Z"),
          toolEvent("e-c", "tc-c-second", "2026-11-01T10:00:04Z"),
          toolEvent("e-over", "tc-over", "2026-11-01T10:00:05Z"),
        ],
        evidence: ["tc-kept", "tc-bad", "tc-c-first", "tc-c-second", "tc-over", "tc-orphan"].map(
          (toolCallId) => ({ toolCallId, output: `body of ${toolCallId}` }),
        ),
      };
      const jobs = makeJobs(env(), [transcriptsImporter([batch])], {
        evidence: store,
        maxEvents: 2,
      });
      const { importId } = jobs.start(transcriptsRequest());
      const finished = await jobs.settled(importId);
      expect(finished.status).toBe("done");
      const read = (id: string) => store.get(PROJECT, id, importId);
      expect(read("tc-kept")?.output?.status).toBe("stored");
      expect(read("tc-c-first")?.output?.status).toBe("stored");
      for (const id of ["tc-bad", "tc-c-second", "tc-over", "tc-orphan"]) {
        expect(read(id)).toBeUndefined();
      }
      expect(finished.counts.evidenceDropped).toBe(4);
      // Nothing leaked into the live scope.
      expect(store.get(PROJECT, "tc-kept")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("reaches the store only after the archive is complete", async () => {
    const store = openStore();
    try {
      const doneAtCall: number[] = [];
      const spy = vi.spyOn(store, "store").mockImplementation(() => {
        doneAtCall.push(env().storage.archives().listDone(PROJECT).length);
      });
      const batches = [
        { events: [toolEvent("e1", "tc-1")], evidence: [{ toolCallId: "tc-1", output: "one" }] },
        {
          events: [toolEvent("e2", "tc-2", "2026-11-01T10:00:01Z")],
          evidence: [{ toolCallId: "tc-2", output: "two" }],
        },
      ];
      const jobs = makeJobs(env(), [transcriptsImporter(batches)], { evidence: store });
      const { importId } = jobs.start(transcriptsRequest());
      expect((await jobs.settled(importId)).status).toBe("done");
      expect(spy).toHaveBeenCalled();
      expect(doneAtCall.every((n) => n === 1)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("leaves no evidence when the import fails or is cancelled", async () => {
    const store = openStore();
    try {
      const spy = vi.spyOn(store, "store");
      const failing: Importer = {
        kind: "transcripts",
        async *run() {
          yield {
            events: [toolEvent("e1", "tc-fail")],
            evidence: [{ toolCallId: "tc-fail", output: "failed body" }],
          };
          throw new Error("boom");
        },
      };
      const jobs = makeJobs(env(), [failing], { evidence: store });
      const failed = jobs.start(transcriptsRequest());
      expect((await jobs.settled(failed.importId)).status).toBe("failed");

      const gate = gatedImporter(
        {
          events: [toolEvent("e2", "tc-cancel")],
          evidence: [{ toolCallId: "tc-cancel", output: "cancelled body" }],
        },
        "transcripts",
      );
      const cancelJobs = makeJobs(env(), [gate.importer], { evidence: store });
      const cancelled = cancelJobs.start(transcriptsRequest());
      await gate.started;
      await cancelJobs.close();
      expect(cancelJobs.status(cancelled.importId)?.status).toBe("cancelled");

      expect(spy).not.toHaveBeenCalled();
      expect(store.get(PROJECT, "tc-fail", failed.importId)).toBeUndefined();
      expect(store.get(PROJECT, "tc-cancel", cancelled.importId)).toBeUndefined();
      expect(store.stats(PROJECT).bodies).toBe(0);
    } finally {
      store.close();
    }
  });

  it("never lets imported evidence shadow, or be shadowed by, live evidence for the same call", async () => {
    const store = openStore();
    try {
      // X: live first, import second. Y: import first, live second.
      store.store(PROJECT, [{ toolCallId: "X", output: "live body of X" }]);
      const importer = transcriptsImporter([
        {
          events: [toolEvent("e-x", "X"), toolEvent("e-y", "Y", "2026-11-01T10:00:01Z")],
          evidence: [
            { toolCallId: "X", output: "archive body of X" },
            { toolCallId: "Y", output: "archive body of Y" },
          ],
        },
      ]);
      const jobs = makeJobs(env(), [importer], { evidence: store });
      const { importId } = jobs.start(transcriptsRequest());
      expect((await jobs.settled(importId)).status).toBe("done");
      store.store(PROJECT, [{ toolCallId: "Y", output: "live body of Y" }]);

      const text = (body: { output?: { status: string; text?: string } | null } | undefined) =>
        body?.output?.status === "stored" ? body.output.text : undefined;
      expect(text(store.get(PROJECT, "X"))).toContain("live body of X");
      expect(text(store.get(PROJECT, "X", importId))).toContain("archive body of X");
      expect(text(store.get(PROJECT, "Y"))).toContain("live body of Y");
      expect(text(store.get(PROJECT, "Y", importId))).toContain("archive body of Y");
    } finally {
      store.close();
    }
  });

  it("drops evidence past the per-import byte budget and counts it, leaving live bodies alone", async () => {
    const store = openStore();
    try {
      store.store(PROJECT, [{ toolCallId: "live", output: "live body" }]);
      const liveBefore = store.stats(PROJECT);
      const importer = transcriptsImporter([
        {
          events: [toolEvent("e-a", "tc-a"), toolEvent("e-b", "tc-b", "2026-11-01T10:00:01Z")],
          evidence: [
            { toolCallId: "tc-a", output: "a".repeat(600) },
            { toolCallId: "tc-b", output: "b".repeat(600) },
          ],
        },
      ]);
      const jobs = makeJobs(env(), [importer], { evidence: store, maxEvidenceBytes: 1000 });
      const { importId } = jobs.start(transcriptsRequest());
      const finished = await jobs.settled(importId);
      expect(finished.status).toBe("done");
      expect(store.get(PROJECT, "tc-a", importId)?.output?.status).toBe("stored");
      expect(store.get(PROJECT, "tc-b", importId)).toBeUndefined();
      expect(finished.counts.evidenceDropped).toBe(1);
      expect(env().storage.archives().get(importId)?.counts.evidenceDropped).toBe(1);
      expect(store.get(PROJECT, "live")?.output?.status).toBe("stored");
      expect(store.stats(PROJECT).bytes).toBeLessThanOrEqual(liveBefore.bytes + 1000);
    } finally {
      store.close();
    }
  });

  it("drops an evidence item over the raw item limit before it reaches the store", async () => {
    const store = openStore();
    try {
      const spy = vi.spyOn(store, "store");
      const importer = transcriptsImporter([
        {
          events: [
            toolEvent("e-s", "tc-small"),
            toolEvent("e-h", "tc-huge", "2026-11-01T10:00:01Z"),
          ],
          evidence: [
            { toolCallId: "tc-small", output: "small" },
            { toolCallId: "tc-huge", output: "z".repeat(5000) },
          ],
        },
      ]);
      const jobs = makeJobs(env(), [importer], { evidence: store, maxEvidenceItemBytes: 1000 });
      const { importId } = jobs.start(transcriptsRequest());
      const finished = await jobs.settled(importId);
      expect(finished.status).toBe("done");
      expect(store.get(PROJECT, "tc-small", importId)?.output?.status).toBe("stored");
      expect(store.get(PROJECT, "tc-huge", importId)).toBeUndefined();
      expect(JSON.stringify(spy.mock.calls)).not.toContain("zzzzzzzz");
      expect(finished.counts.evidenceDropped).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("importers that throw odd things, and recording failures (security M1)", () => {
  function throwing(value: unknown): Importer {
    return {
      kind: "git",
      // biome-ignore lint/correctness/useYield: throws before yielding on purpose
      async *run() {
        throw value;
      },
    };
  }

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "just text"],
    ["a number", 42],
  ])("fails the archive with importer_failed when the importer throws %s", async (_name, value) => {
    const jobs = makeJobs(env(), [throwing(value)]);
    let finished: Awaited<ReturnType<typeof jobs.settled>> | undefined;
    const unhandled = await unhandledDuring(async () => {
      const { importId } = jobs.start(request());
      finished = await jobs.settled(importId);
    });
    expect(unhandled).toEqual([]);
    expect(finished?.status).toBe("failed");
    expect(finished?.error?.code).toBe("importer_failed");
    expect(env().storage.archives().running(PROJECT)).toBeUndefined();
  });

  it("does not reject or leave the project blocked when recording the failure throws", async () => {
    const archives = env().storage.archives();
    vi.spyOn(archives, "fail").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const jobs = makeJobs(env(), [throwing(new Error("boom"))]);
    let settledOk = false;
    const unhandled = await unhandledDuring(async () => {
      const { importId } = jobs.start(request());
      await jobs.settled(importId);
      settledOk = true;
    });
    expect(unhandled).toEqual([]);
    expect(settledOk).toBe(true);
    expect(archives.running(PROJECT)).toBeUndefined();
    expect(refusalCode(() => jobs.start(request()))).toBeUndefined();
    await jobs.close();
  });

  it("does not leave the project blocked when recording the cancel throws", async () => {
    const archives = env().storage.archives();
    // Throws twice, so a plain retry of cancel is not enough: the project must still be freed.
    const broken = () => {
      throw new Error("disk full");
    };
    vi.spyOn(archives, "cancel").mockImplementationOnce(broken).mockImplementationOnce(broken);
    const gate = gatedImporter({ events: [commitEvent("a", "2026-11-01T10:00:00Z")] });
    const jobs = makeJobs(env(), [gate.importer]);
    const { importId } = jobs.start(request());
    await gate.started;
    const unhandled = await unhandledDuring(() => jobs.close());
    expect(unhandled).toEqual([]);
    expect(jobs.status(importId)?.status).not.toBe("running");
    expect(archives.running(PROJECT)).toBeUndefined();
  });
});

describe("bounds (security M3)", () => {
  it("marks an event over the event size limit payload_too_large", async () => {
    const big = commitEvent("big", "2026-11-01T10:00:01Z", {
      overrides: {
        payload: { repo: "r", sha: "a".repeat(40), parents: [], subject: "s".repeat(2000) },
      },
    });
    const ok = commitEvent("ok", "2026-11-01T10:00:02Z");
    const jobs = makeJobs(env(), [fakeImporter([{ events: [big, ok] }])], { maxEventBytes: 600 });
    const { importId, archiveId } = jobs.start(request());
    const finished = await jobs.settled(importId);
    expect(finished.status).toBe("done");
    expect(finished.counts).toMatchObject({
      imported: 1,
      malformed: 1,
      malformedByCode: { payload_too_large: 1 },
    });
    expect(
      env()
        .storage.archives()
        .events(archiveId, 1, 10)
        .map((e) => e.sourceEventId),
    ).toEqual(["ok"]);
  });

  it("limits the serialized event to 64 KB by default", async () => {
    const huge = toolEvent("huge", "tc-huge", "2026-11-01T10:00:01Z", {
      payload: { toolCallId: "tc-huge", toolName: "Bash", summary: "s".repeat(100 * 1024) },
    });
    const jobs = makeJobs(env(), [transcriptsImporter([{ events: [huge] }])]);
    const { importId } = jobs.start(transcriptsRequest());
    const finished = await jobs.settled(importId);
    expect(finished.counts).toMatchObject({
      imported: 0,
      malformed: 1,
      malformedByCode: { payload_too_large: 1 },
    });
  });

  it("runs one import engine-wide: a second project is refused with import_running", async () => {
    const other = join(env().dir, "other-repo");
    mkdirSync(other);
    addProject(env().storage, "other", [other]);
    const gate = gatedImporter({ events: [commitEvent("a", "2026-11-01T10:00:00Z")] });
    const jobs = makeJobs(env(), [gate.importer]);
    const first = jobs.start(request());
    expect(refusalCode(() => jobs.start({ projectId: "other", kind: "git", root: other }))).toBe(
      "import_running",
    );
    gate.release();
    await jobs.settled(first.importId);
    expect(
      refusalCode(() => jobs.start({ projectId: "other", kind: "git", root: other })),
    ).toBeUndefined();
    await jobs.close();
  });

  it("stops the importer at the event cap and finishes done with truncated: true", async () => {
    let yields = 0;
    let cleaned = false;
    const importer: Importer = {
      kind: "git",
      async *run() {
        try {
          for (let i = 0; i < 100; i += 1) {
            yields += 1;
            yield {
              events: [commitEvent(`c-${i}`, "2026-11-01T10:00:00Z", { sourceSequence: i })],
            };
          }
        } finally {
          cleaned = true;
        }
        return { read: 100, imported: 100, skipped: 0, malformed: 0 };
      },
    };
    const jobs = makeJobs(env(), [importer], { maxEvents: 3 });
    const { importId, archiveId } = jobs.start(request());
    const finished = await jobs.settled(importId);
    expect(finished.status).toBe("done");
    expect(finished.counts).toMatchObject({ imported: 3, truncated: true });
    expect(cleaned).toBe(true);
    expect(yields).toBeLessThanOrEqual(4);
    expect(env().storage.archives().events(archiveId, 1, 100)).toHaveLength(3);
  });
});

describe("robustness (security lows)", () => {
  it("does not block the event loop during a large multi-batch import", async () => {
    const batches: ImportBatch[] = Array.from({ length: 100 }, (_, b) => ({
      events: Array.from({ length: 20 }, (_, i) =>
        commitEvent(`c-${b}-${i}`, "2026-11-01T10:00:00Z", { sourceSequence: b * 20 + i }),
      ),
    }));
    const jobs = makeJobs(env(), [fakeImporter(batches)]);
    const order: string[] = [];
    const { importId } = jobs.start(request());
    setImmediate(() => order.push("tick"));
    setTimeout(() => order.push("timer"), 0);
    await jobs.settled(importId);
    order.push("finished");
    expect(order.indexOf("tick")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("tick")).toBeLessThan(order.indexOf("finished"));
    expect(order.indexOf("timer")).toBeLessThan(order.indexOf("finished"));
  });

  it("builds the archive label from the configured root, not the symlink target", async () => {
    const target = join(env().dir, "weird-secret-dir-name");
    mkdirSync(target);
    const link = join(env().dir, "proj-link");
    symlinkSync(target, link);
    addProject(env().storage, "linked", [link]);
    const jobs = makeJobs(env(), [fakeImporter([])]);
    const { archiveId } = jobs.start({ projectId: "linked", kind: "git", root: link });
    await jobs.settled(archiveId);
    const label = env().storage.archives().get(archiveId)?.label ?? "";
    expect(label).toBe("git: proj-link");
    expect(label).not.toContain("weird-secret");
  });

  it("caps the archive label length", async () => {
    const long = join(env().dir, "r".repeat(200));
    mkdirSync(long);
    addProject(env().storage, "long", [long]);
    const jobs = makeJobs(env(), [fakeImporter([])]);
    const { archiveId } = jobs.start({ projectId: "long", kind: "git", root: long });
    await jobs.settled(archiveId);
    const label = env().storage.archives().get(archiveId)?.label ?? "";
    expect(label.startsWith("git: r")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(100);
  });

  it("sanitizes importer-supplied counts in the final status and the stored archive", async () => {
    const final = {
      read: 5,
      imported: 99,
      skipped: -3,
      malformed: 1.5,
      extra: "leaked source text",
    } as never;
    const jobs = makeJobs(env(), [fakeImporter([], { final })]);
    const { importId } = jobs.start(request());
    const finished = await jobs.settled(importId);
    const allowed = new Set([
      "read",
      "imported",
      "skipped",
      "malformed",
      "malformedByCode",
      "truncated",
      "evidenceDropped",
    ]);
    for (const counts of [finished.counts, env().storage.archives().get(importId)?.counts ?? {}]) {
      expect(Object.keys(counts).filter((key) => !allowed.has(key))).toEqual([]);
      expect(counts).toMatchObject({ read: 5, imported: 0, skipped: 0, malformed: 0 });
    }
    expect(JSON.stringify(finished)).not.toContain("leaked source text");
  });

  it("sanitizes progress reports while running", async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reported: () => void = () => {};
    const progressed = new Promise<void>((resolve) => {
      reported = resolve;
    });
    const importer: Importer = {
      kind: "git",
      // biome-ignore lint/correctness/useYield: never yields on purpose
      async *run(context: ImportContext) {
        context.progress({
          read: -1,
          imported: 2.5,
          skipped: 4,
          malformed: 0,
          secret: "x",
        } as never);
        reported();
        await released;
        return { read: 0, imported: 0, skipped: 0, malformed: 0 };
      },
    };
    const jobs = makeJobs(env(), [importer]);
    const { importId } = jobs.start(request());
    await progressed;
    expect(jobs.status(importId)?.counts).toEqual({
      read: 0,
      imported: 0,
      skipped: 4,
      malformed: 0,
    });
    release();
    await jobs.settled(importId);
  });

  it("returns from close() within the timeout even when the importer ignores the signal", async () => {
    const importer: Importer = {
      kind: "git",
      async *run() {
        await new Promise<void>(() => {});
        return { read: 0, imported: 0, skipped: 0, malformed: 0 };
      },
    };
    const jobs = makeJobs(env(), [importer], { closeTimeoutMs: 50 });
    const { importId } = jobs.start(request());
    await new Promise((resolve) => setImmediate(resolve));
    const outcome = await Promise.race([
      jobs.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ]);
    expect(outcome).toBe("closed");
    expect(jobs.status(importId)?.status).not.toBe("running");
    expect(env().storage.archives().running(PROJECT)).toBeUndefined();
  });

  it("never calls the importer for a job aborted before it starts", async () => {
    let ran = 0;
    const importer = fakeImporter([{ events: [commitEvent("a", "2026-11-01T10:00:00Z")] }], {
      onRun: () => {
        ran += 1;
      },
    });
    const jobs = makeJobs(env(), [importer]);
    const { importId } = jobs.start(request());
    await jobs.close();
    expect(ran).toBe(0);
    expect(jobs.status(importId)?.status).toBe("cancelled");
  });

  it("refuses start after close with engine_closing", async () => {
    const jobs = makeJobs(env(), [fakeImporter([])]);
    await jobs.close();
    expect(refusalCode(() => jobs.start(request()))).toBe("engine_closing");
  });
});
