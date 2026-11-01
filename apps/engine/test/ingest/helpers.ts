import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, beforeEach } from "vitest";
import {
  clientContentHash,
  ENGINE_SOURCE_ID,
  ensureUnsortedProject,
  openStorage,
  type Storage,
} from "../../src/storage/index.ts";

export const T0 = "2026-10-30T12:00:00.000Z";
export const fixedNow = () => new Date(Date.parse(T0));

/** Opens a fresh database per test with the given projects (each with its project.created). */
export function useStorage(projects: readonly string[] = ["demo"]): {
  storage: () => Storage;
  path: () => string;
} {
  let dir = "";
  let storage: Storage | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "taskville-ingest-"));
    storage = openStorage(join(dir, "taskville.db"));
    ensureUnsortedProject(storage, { now: fixedNow });
    for (const id of projects) if (id !== "unsorted") addProject(storage, id);
  });
  afterEach(() => {
    try {
      storage?.close();
    } catch {
      // A test may already have closed it.
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    storage: () => {
      if (!storage) throw new Error("storage not open");
      return storage;
    },
    path: () => join(dir, "taskville.db"),
  };
}

/** What `POST /v1/projects` (#16) will do: the project row and its project.created event. */
export function addProject(storage: Storage, id: string, roots: readonly string[] = []): void {
  storage.transaction((tx) => {
    tx.insertProject({ id, name: id, createdAt: T0, roots: [...roots], builtin: false });
    const created: StoredEnvelope = {
      schemaVersion: 1,
      eventId: randomUUID(),
      projectId: id,
      sourceId: ENGINE_SOURCE_ID,
      sourceEventId: `project.created:${id}`,
      occurredAt: T0,
      receivedAt: T0,
      ingestSequence: 1,
      type: "project.created",
      payload: { name: id, roots: [...roots], builtin: false },
      evidenceIds: [],
      provenance: "live",
      late: false,
    };
    tx.appendEvent(created, clientContentHash(created));
  });
}

/** A minimal valid input event. */
export function input(
  sourceEventId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: "demo",
    sourceId: "adapter:test",
    sourceEventId,
    occurredAt: "2026-10-30T11:00:00Z",
    type: "agent.connected",
    agentId: "agent-1",
    payload: {},
    provenance: "live",
    ...overrides,
  };
}

// Fake secrets are assembled at runtime from parts, so no token-shaped literal
// sits in the source for secret scanners to match (M1.20 lesson).
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function fakeGithubToken(seed = 7): string {
  let s = seed >>> 0;
  let out = "";
  for (let i = 0; i < 36; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += B62[s % B62.length];
  }
  return `${["gh", "p_"].join("")}${out}`;
}
