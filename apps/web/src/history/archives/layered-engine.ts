import { expect } from "vitest";
import {
  type StoredEnvelope,
  snapshotResponseSchema,
  storedEnvelopeSchema,
} from "../../../../../packages/protocol/src/index.ts";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { initialState, projectStateHash, REDUCER_VERSION, reduce } from "../../data/domain.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";

// Review-round fixture: archives layered over an optional base fetcher (the live recording, or
// the whole cards engine), with every request recorded, mutable archives, and per-request
// failure and hold rules. Archive routes read positions on the occurredAt clock, attention [].

export interface ArchiveSpec {
  id: string;
  archiveKind: "git" | "transcripts";
  label: string;
  log: readonly StoredEnvelope[];
}

export interface Call {
  url: URL;
  method: string;
}

type Match = (url: URL) => boolean;

export const stateOf = (log: readonly StoredEnvelope[], position: number) =>
  log.slice(0, position).reduce(reduce, initialState(PROJECT));

const IMPORTED_AT = "2026-11-08T09:00:00Z";

/** Archive events: all received at import time, placed by occurredAt (sorted ascending). */
export function archiveEvents(
  prefix: string,
  specs: ReadonlyArray<Record<string, unknown> & { occurredAt: string }>,
): StoredEnvelope[] {
  return specs.map((spec, index) =>
    storedEnvelopeSchema.parse({
      schemaVersion: 1,
      projectId: PROJECT,
      sourceId: `import-${prefix}`,
      sourceEventId: `${prefix}-${index + 1}`,
      eventId: `00000000-0000-4000-83${prefix.length % 10}0-${String(index + 1).padStart(12, "0")}`,
      ingestSequence: index + 1,
      receivedAt: IMPORTED_AT,
      evidenceIds: [],
      provenance: "imported",
      late: false,
      ...spec,
    }),
  );
}

export function layeredEngine(options: { base?: typeof fetch; archives: ArchiveSpec[] }) {
  const { base, archives } = options;
  const calls: Call[] = [];
  const rules: Array<{ match: Match; mode: "fail" | "hold"; gate?: Promise<void> }> = [];
  const listing = `/v1/projects/${PROJECT}/timelines`;

  const entries = () =>
    archives.map((archive) => ({
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
    }));

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const path = decodeURIComponent(url.pathname);
    const rule = rules.find((item) => item.match(url));
    if (rule?.mode === "fail") return new Response("boom", { status: 500 });
    if (rule?.mode === "hold") {
      await rule.gate;
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    }
    if (path === listing) {
      const live = base
        ? await (await base(input, init)).json()
        : { projectId: PROJECT, timelines: [] };
      return Response.json({ ...live, timelines: [...live.timelines, ...entries()] });
    }
    const archive = archives.find((item) => path.startsWith(`/v1/timelines/${item.id}/`));
    if (!archive) {
      if (base) return base(input, init);
      return new Response("not found", { status: 404 });
    }
    expect(method).toBe("GET");
    expect(new Headers(init?.headers).get(SESSION_HEADER)).toBe(SECRET);
    const { log } = archive;
    const position = (raw: string) =>
      /^\d+$/.test(raw)
        ? Math.min(Number(raw), log.length)
        : (log.filter((event) => Date.parse(event.occurredAt) <= Date.parse(raw)).at(-1)
            ?.ingestSequence ?? 0);
    if (path.endsWith("/events")) {
      const from = Math.max(1, Number(url.searchParams.get("from") ?? 1));
      const to = position(url.searchParams.get("to") ?? String(log.length));
      return Response.json({
        timelineId: archive.id,
        events: log.filter((event) => event.ingestSequence >= from && event.ingestSequence <= to),
        nextCursor: null,
      });
    }
    const at = position(url.searchParams.get("at") ?? "");
    const state = stateOf(log, at);
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

  return {
    fetcher,
    calls,
    archives,
    /** Requests matching `match` answer 500 from now on. */
    fail(match: Match) {
      rules.push({ match, mode: "fail" });
    },
    /** Requests matching `match` wait until `release()`; later ones are not held. */
    hold(match: Match) {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rule = { match, mode: "hold" as const, gate };
      rules.push(rule);
      return () => {
        rules.splice(rules.indexOf(rule), 1);
        release();
      };
    },
  };
}
