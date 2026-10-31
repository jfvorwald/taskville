import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { IngestPipeline } from "../../../src/ingest/index.ts";
import { createProject } from "../../../src/projects/index.ts";
import {
  type ClaudeCodeMapper,
  ClaudeCodeSource,
  type ClaudeCodeSourceOptions,
  type MapContext,
} from "../../../src/sources/claude-code/index.ts";
import { ensureUnsortedProject, openStorage, type Storage } from "../../../src/storage/index.ts";

export const T0 = "2026-10-31T12:00:00.000Z";
export const fixedNow = () => new Date(Date.parse(T0));

/** A fresh database per test with Unsorted plus the given projects and their roots. */
export function useProjects(projects: readonly { id: string; roots: string[] }[]): () => Storage {
  let dir = "";
  let storage: Storage | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "taskville-cc-"));
    storage = openStorage(join(dir, "taskville.db"));
    ensureUnsortedProject(storage, { now: fixedNow });
    for (const p of projects) createProject(storage, { ...p, name: p.id }, { now: fixedNow });
  });
  afterEach(() => {
    storage?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    if (!storage) throw new Error("storage not open");
    return storage;
  };
}

/**
 * Stand-in for the M2.03 mapper (#22): one `agent.connected` per hook, keyed by
 * the hook's `session_id` (or `agent_id`), with the context's fields applied.
 * It records every call so tests can check the context the engine passed.
 */
export function standInMapper(): ClaudeCodeMapper & { calls: MapContext[] } {
  const calls: MapContext[] = [];
  const mapper = (payload: unknown, ctx: MapContext) => {
    calls.push(ctx);
    const hook = payload as Record<string, unknown>;
    if (hook.hook_event_name === "Ignored") return { events: [], ignored: "not mapped" };
    const agentId = typeof hook.agent_id === "string" ? hook.agent_id : hook.session_id;
    return {
      events: [
        {
          schemaVersion: 1,
          projectId: ctx.projectId,
          sourceId: "claude-code",
          sourceEventId: `${ctx.sourceEventId}:0`,
          occurredAt: ctx.receivedAt,
          type: "agent.connected",
          agentId,
          payload: {},
          provenance: "live",
          late: ctx.late,
        },
      ],
      ...(typeof hook.tool_use_id === "string"
        ? {
            evidence: [
              { toolCallId: hook.tool_use_id, input: hook.tool_input, output: hook.tool_response },
            ],
          }
        : {}),
    };
  };
  return Object.assign(mapper, { calls });
}

export function makeSource(
  storage: Storage,
  extra: Partial<ClaudeCodeSourceOptions> = {},
): { source: ClaudeCodeSource; mapper: ReturnType<typeof standInMapper> } {
  const mapper = standInMapper();
  const pipeline = new IngestPipeline({ storage, now: fixedNow });
  const source = new ClaudeCodeSource({ pipeline, storage, mapper, now: fixedNow, ...extra });
  return { source, mapper };
}
