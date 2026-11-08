import { expect } from "vitest";
import {
  type StoredEnvelope,
  snapshotResponseSchema,
  storedEnvelopeSchema,
} from "../../../../../packages/protocol/src/index.ts";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { initialState, projectStateHash, REDUCER_VERSION, reduce } from "../../data/domain.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";

// A stand-in for the engine's archive timelines (apps/engine/src/timelines/routes.ts): the list
// route serves the live recording and then the done archives, and an `archive:<uuid>` id reads
// state and events at archive positions 1..eventCount on the occurredAt clock, with attention [].
// Live ids are delegated to the existing timeline fixture.

export const GIT_ARCHIVE = "archive:5b0c8f2e-3c1d-4a77-9a55-0d6f1e2a7b01";
export const TRANSCRIPT_ARCHIVE = "archive:9e4a7d10-61f2-4c0b-8b3e-72c5a9d4f802";
export const GIT_LABEL = "Repo history (taskville)";
export const TRANSCRIPT_LABEL = "Claude Code transcripts";
/** Archive events were received when they were imported, long after they occurred. */
const IMPORTED_AT = "2026-11-08T09:00:00Z";

const sha = (char: string) => char.repeat(40);

function archiveLog(specs: Array<Record<string, unknown>>, prefix: string): StoredEnvelope[] {
  return specs.map((spec, index) =>
    storedEnvelopeSchema.parse({
      schemaVersion: 1,
      projectId: PROJECT,
      sourceId: `import-${prefix}`,
      sourceEventId: `${prefix}-${index + 1}`,
      eventId: `00000000-0000-4000-8${prefix === "git" ? "1" : "2"}00-${String(index + 1).padStart(12, "0")}`,
      ingestSequence: index + 1,
      receivedAt: IMPORTED_AT,
      evidenceIds: [],
      provenance: "imported",
      late: false,
      ...spec,
    }),
  );
}

/** Git facts only: no agent is ever registered. Sorted by occurredAt, three distinct days. */
export const GIT_LOG = archiveLog(
  [
    {
      type: "git.commit",
      occurredAt: "2026-03-02T10:00:00Z",
      payload: { repo: "taskville", sha: sha("a"), parents: [], subject: "Initial commit" },
    },
    {
      type: "git.commit",
      occurredAt: "2026-03-03T10:00:00Z",
      payload: { repo: "taskville", sha: sha("b"), parents: [sha("a")], subject: "Add city" },
    },
    {
      type: "git.ref_moved",
      occurredAt: "2026-03-03T10:05:00Z",
      payload: { repo: "taskville", ref: "refs/heads/main", from: sha("a"), to: sha("b") },
    },
    {
      type: "git.merge",
      occurredAt: "2026-03-04T10:00:00Z",
      payload: { repo: "taskville", sha: sha("c"), parents: [sha("b"), sha("d")] },
    },
  ],
  "git",
);

/** A transcript archive: agents and a task, on days that differ from the Git archive's. */
export const TRANSCRIPT_LOG = archiveLog(
  [
    {
      type: "agent.registered",
      agentId: "t1",
      occurredAt: "2026-02-10T09:00:00Z",
      payload: { sourceAgentId: "source-t1", displayName: "Tess", role: "dev", kind: "session" },
    },
    {
      type: "task.created",
      agentId: "t1",
      taskId: "tt1",
      occurredAt: "2026-02-10T09:05:00Z",
      payload: { title: "Transcribed task" },
    },
  ],
  "transcripts",
);

export const stateIn = (log: readonly StoredEnvelope[], position: number) =>
  log.slice(0, position).reduce(reduce, initialState(PROJECT));

const ARCHIVES = [
  // Engine order is import order; the picker lists archives by label.
  { id: GIT_ARCHIVE, archiveKind: "git", label: GIT_LABEL, log: GIT_LOG },
  {
    id: TRANSCRIPT_ARCHIVE,
    archiveKind: "transcripts",
    label: TRANSCRIPT_LABEL,
    log: TRANSCRIPT_LOG,
  },
] as const;

export function archiveEngine() {
  const live = timelineEngine();
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    const path = decodeURIComponent(url.pathname);
    if (path === `/v1/projects/${PROJECT}/timelines`) {
      const base = await (await live.fetcher(input, init)).json();
      return Response.json({
        ...base,
        timelines: [
          ...base.timelines,
          ...ARCHIVES.map((archive) => ({
            id: archive.id,
            kind: "archive",
            archiveKind: archive.archiveKind,
            label: archive.label,
            projectId: PROJECT,
            firstSequence: 1,
            lastSequence: archive.log.length,
            firstAt: archive.log[0].occurredAt,
            lastAt: archive.log.at(-1)?.occurredAt,
            eventCount: archive.log.length,
          })),
        ],
      });
    }
    const archive = ARCHIVES.find((item) => path.startsWith(`/v1/timelines/${item.id}/`));
    if (!archive) return live.fetcher(input, init);
    requests.push(url);
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get(SESSION_HEADER)).toBe(SECRET);
    const { log } = archive;
    const position = (raw: string) =>
      /^\d+$/.test(raw)
        ? Math.min(Number(raw), log.length)
        : (log.filter((event) => Date.parse(event.occurredAt) <= Date.parse(raw)).at(-1)
            ?.ingestSequence ?? 0);
    if (path.endsWith("/events")) {
      expect(url.searchParams.has("cursor")).toBe(false);
      const fromRaw = url.searchParams.get("from");
      const from =
        fromRaw === null
          ? 1
          : /^\d+$/.test(fromRaw)
            ? Math.max(1, Number(fromRaw))
            : (log.find((event) => Date.parse(event.occurredAt) >= Date.parse(fromRaw))
                ?.ingestSequence ?? log.length + 1);
      const to = position(url.searchParams.get("to") ?? String(log.length));
      return Response.json({
        timelineId: archive.id,
        events: log.filter((event) => event.ingestSequence >= from && event.ingestSequence <= to),
        nextCursor: null,
      });
    }
    expect(path).toBe(`/v1/timelines/${archive.id}/state`);
    const at = position(url.searchParams.get("at") ?? "");
    const state = stateIn(log, at);
    const snapshot = snapshotResponseSchema.parse({
      projectId: PROJECT,
      cursor: state.head,
      reducerVersion: REDUCER_VERSION,
      stateHash: projectStateHash(state),
      state,
      attention: [],
      computedAt: "2026-11-08T12:00:00Z",
    });
    const { projectId: _projectId, ...wire } = snapshot;
    return Response.json({ timelineId: archive.id, at: state.head, ...wire });
  };
  return { fetcher, requests, liveRequests: live.requests };
}
