import { PROJECT } from "../../../test/data/fake-engine.ts";
import {
  initialState,
  projectStateHash,
  REDUCER_VERSION,
  snapshotResponseSchema,
} from "../../data/domain.ts";

// A 200,000 event archive served page by page from a generator: one git commit a minute, so
// every event is a marker candidate. State is only a head, as nothing here replays reductions.
// `control.failState` makes every later state read answer 500.

export const COUNT = 200_000;
export const PAGE = 200;
export const T0 = Date.parse("2026-01-01T00:00:00Z");
export const MINUTE = 60_000;
export const ID = "archive:3d9e5b70-8c21-4a6f-b7d4-1e0f2a3b4c55";
const sha = "e".repeat(40);

export const occurred = (sequence: number) => new Date(T0 + (sequence - 1) * MINUTE).toISOString();

const event = (sequence: number) => ({
  schemaVersion: 1,
  projectId: PROJECT,
  sourceId: "import-scale",
  sourceEventId: `scale-${sequence}`,
  eventId: `00000000-0000-4000-8400-${String(sequence).padStart(12, "0")}`,
  ingestSequence: sequence,
  receivedAt: "2026-11-08T09:00:00Z",
  evidenceIds: [],
  provenance: "imported",
  late: false,
  type: "git.commit",
  occurredAt: occurred(sequence),
  payload: { repo: "taskville", sha, parents: [], subject: `commit ${sequence}` },
});

export function scaleEngine() {
  const pages = { count: 0 };
  const control = { failState: false };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input), location.origin);
    const path = decodeURIComponent(url.pathname);
    if (path === `/v1/projects/${PROJECT}/timelines`) {
      return Response.json({
        projectId: PROJECT,
        timelines: [
          {
            id: ID,
            kind: "archive",
            archiveKind: "git",
            label: "Huge repo",
            projectId: PROJECT,
            firstSequence: 1,
            lastSequence: COUNT,
            firstAt: occurred(1),
            lastAt: occurred(COUNT),
            eventCount: COUNT,
          },
        ],
      });
    }
    if (path === `/v1/timelines/${ID}/events`) {
      pages.count += 1;
      const cursor = url.searchParams.get("cursor");
      const from = cursor
        ? Number(cursor.slice(1))
        : Math.max(1, Number(url.searchParams.get("from") ?? 1));
      const to = Math.min(COUNT, Number(url.searchParams.get("to") ?? COUNT));
      const last = Math.min(to, from + PAGE - 1);
      const events = [];
      for (let sequence = from; sequence <= last; sequence += 1) events.push(event(sequence));
      return Response.json({
        timelineId: ID,
        events,
        nextCursor: last < to ? `c${last + 1}` : null,
      });
    }
    if (control.failState) return new Response("boom", { status: 500 });
    // State: only the head matters to the strip, so skip replaying 200,000 reductions.
    const raw = url.searchParams.get("at") ?? "";
    const at = /^\d+$/.test(raw)
      ? Math.min(Number(raw), COUNT)
      : Math.min(COUNT, Math.max(0, Math.floor((Date.parse(raw) - T0) / MINUTE) + 1));
    const state = { ...initialState(PROJECT), head: at };
    const snapshot = snapshotResponseSchema.parse({
      projectId: PROJECT,
      cursor: at,
      reducerVersion: REDUCER_VERSION,
      stateHash: projectStateHash(state),
      state,
      attention: [],
      computedAt: "2026-11-08T12:00:00Z",
    });
    const { projectId: _projectId, ...wire } = snapshot;
    return Response.json({ timelineId: ID, at, ...wire });
  };
  return { fetcher, pages, control };
}
