import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredEnvelope } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, openStorage } from "../../src/storage/index.ts";
import { envelope, HASH_A, useTempDir } from "./helpers.ts";

// M5.14 (#281): migration V6 (V3 before main gained V3 to V5) adds the agent index (`agent_events`), a trigger that keeps it, and a
// backfill for databases that already hold events. V1 and V2 are not exported, so the V2 state is
// built through the real migrate API: open at the latest schema, then with a raw connection drop
// the V3 objects (trigger, table with its indexes) and the version-3 record, which is exactly
// what a V2 database looks like. Reopening runs migration V3 over a log that has events.

const dir = useTempDir();

/** Events across agents and sessions; two events name no agent (they are never indexed). */
const SPEC: { agentId?: string; sessionId?: string; type: string }[] = [
  { agentId: "a", sessionId: "s1", type: "session.started" },
  { agentId: "b", sessionId: "s1", type: "tool_call.started" },
  { agentId: "a", sessionId: "s2", type: "tool_call.started" },
  { agentId: "c", type: "agent.connected" },
  { type: "team.ended" },
  { agentId: "b", sessionId: "s3", type: "agent.connected" },
  { agentId: "a", type: "agent.connected" },
  { sessionId: "s1", type: "team.ended" },
];

function build(seq: number, spec: (typeof SPEC)[number], projectId = "p1"): StoredEnvelope {
  const { agentId, sessionId, type } = spec;
  const payload =
    type === "tool_call.started"
      ? { toolCallId: "t", toolName: "Bash" }
      : type === "team.ended"
        ? { teamId: "team-1" }
        : {};
  // An explicit undefined replaces the helper's default agent, so the event names none.
  return envelope(projectId, seq, { type, agentId, sessionId, payload });
}

function seed(path: string): StoredEnvelope[] {
  const storage = openStorage(path);
  const log: StoredEnvelope[] = [];
  try {
    storage.transaction((tx) => {
      tx.insertProject({ id: "p1", name: "One", roots: [], builtin: false, createdAt: "t" });
      tx.insertProject({ id: "p2", name: "Two", roots: [], builtin: false, createdAt: "t" });
      SPEC.forEach((spec, i) => {
        const e = build(i + 1, spec);
        tx.appendEvent(e, HASH_A);
        log.push(e);
      });
      // Another project's event for agent "a": the index is per project.
      tx.appendEvent(
        build(1, { agentId: "a", sessionId: "s1", type: "agent.connected" }, "p2"),
        HASH_A,
      );
    });
  } finally {
    storage.close();
  }
  return log;
}

/** Agentless events retention reads; the feed subset includes them for every agent (roborev 7827). */
const RETENTION = new Set(["team.started", "team.ended", "request.expired"]);

/** Turns the database into one written before the agent index (V6): no index, no trigger, version 6 not recorded. */
function downgradeToV2(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec("DROP TRIGGER events_index_agent");
    raw.exec("DROP TABLE agent_events");
    raw.exec("DELETE FROM schema_migrations WHERE version = 6");
    expect(raw.prepare("SELECT max(version) AS v FROM schema_migrations").get()?.v).toBe(5);
  } finally {
    raw.close();
  }
}

function indexRows(path: string): unknown[] {
  const raw = new DatabaseSync(path);
  try {
    return raw
      .prepare(
        `SELECT project_id, agent_id, ingest_sequence, session_id, type FROM agent_events
         ORDER BY project_id, agent_id, ingest_sequence`,
      )
      .all();
  } finally {
    raw.close();
  }
}

/** What the index must hold, computed from the log alone. */
function expectedRows(log: StoredEnvelope[], projectId = "p1"): unknown[] {
  return log
    .filter((e) => e.agentId !== undefined)
    .map((e) => ({
      project_id: projectId,
      agent_id: e.agentId,
      ingest_sequence: e.ingestSequence,
      session_id: e.sessionId ?? null,
      type: e.type,
    }))
    .sort(
      (x, y) =>
        String(x.agent_id).localeCompare(String(y.agent_id)) ||
        x.ingest_sequence - y.ingest_sequence,
    );
}

const sequences = (events: Iterable<StoredEnvelope>) => [...events].map((e) => e.ingestSequence);

describe("migration V6: the agent index over an existing log", () => {
  it("backfills exactly the rows of the events that name an agent, and records version 6", () => {
    const path = join(dir(), "taskville.db");
    const log = seed(path);
    downgradeToV2(path);

    const storage = openStorage(path);
    storage.close();

    const rows = indexRows(path) as { project_id: string }[];
    expect(rows.filter((r) => r.project_id === "p1")).toEqual(expectedRows(log));
    // Per project: p2 has its one event only.
    expect(rows.filter((r) => r.project_id === "p2")).toHaveLength(1);
    expect(rows).toHaveLength(expectedRows(log).length + 1);
    const again = openStorage(path);
    try {
      expect(again.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      again.close();
    }
    // Reopening at the latest version leaves the index as it was (no second backfill).
    expect(indexRows(path)).toEqual(rows);
  });

  it("answers the lookups for events written before the migration, as a full read of the log does", () => {
    const path = join(dir(), "taskville.db");
    const log = seed(path);
    downgradeToV2(path);

    const storage = openStorage(path);
    try {
      expect(storage.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
      for (const agent of ["a", "b", "c"]) expect(storage.holdsAgent("p1", agent)).toBe(true);
      expect(storage.holdsAgent("p1", "nobody")).toBe(false);
      expect(storage.holdsAgent("p2", "b")).toBe(false);

      const full = [...storage.events("p1", 0)];
      expect(full).toHaveLength(log.length);
      // Agent a: its own events plus every agent-named event in a session it has events in (s1, s2);
      // an event that names no agent is not indexed (event 8 is in s1 and is left out).
      const aSessions = new Set(full.filter((e) => e.agentId === "a").map((e) => e.sessionId));
      const wantA = full
        .filter(
          (e) =>
            e.agentId === "a" ||
            RETENTION.has(e.type) ||
            (e.agentId !== undefined && e.sessionId !== undefined && aSessions.has(e.sessionId)),
        )
        .map((e) => e.ingestSequence);
      expect(sequences(storage.agentFeedEvents("p1", "a"))).toEqual(wantA);
      expect(sequences(storage.agentFeedEvents("p1", "a", wantA[1]))).toEqual(wantA.slice(2));
      // Agent c has one event and no session.
      expect(sequences(storage.agentFeedEvents("p1", "c"))).toEqual(
        full.filter((e) => e.agentId === "c" || RETENTION.has(e.type)).map((e) => e.ingestSequence),
      );
      expect(sequences(storage.agentEventsOfType("p1", "a", "tool_call.started"))).toEqual([3]);
      // An unknown agent still gets the project's agentless retention events (5 and 8), nothing else.
      expect(sequences(storage.agentFeedEvents("p1", "nobody"))).toEqual(
        full.filter((e) => RETENTION.has(e.type)).map((e) => e.ingestSequence),
      );
    } finally {
      storage.close();
    }
  });

  it("indexes events appended after the migration through the trigger", () => {
    const path = join(dir(), "taskville.db");
    seed(path);
    downgradeToV2(path);

    const storage = openStorage(path);
    try {
      expect(storage.holdsAgent("p1", "late")).toBe(false);
      storage.transaction((tx) => {
        tx.appendEvent(
          { ...build(9, { agentId: "late", sessionId: "s9", type: "agent.connected" }) },
          HASH_A,
        );
        tx.appendEvent({ ...build(10, { type: "team.ended" }) }, HASH_A);
      });
      expect(storage.holdsAgent("p1", "late")).toBe(true);
      // Agentless team.ended events (5, 8 and the new 10) are read by retention, so the feed fold
      // includes them for every agent.
      expect(sequences(storage.agentFeedEvents("p1", "late"))).toEqual([5, 8, 9, 10]);
    } finally {
      storage.close();
    }
    const rows = indexRows(path) as { agent_id: string; ingest_sequence: number }[];
    expect(rows.filter((r) => r.agent_id === "late")).toEqual([
      {
        project_id: "p1",
        agent_id: "late",
        ingest_sequence: 9,
        session_id: "s9",
        type: "agent.connected",
      },
    ]);
    // The event that names no agent (10) is not indexed.
    expect(rows.some((r) => r.ingest_sequence === 10)).toBe(false);
  });
});
