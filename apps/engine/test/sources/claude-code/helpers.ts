import { createHash } from "node:crypto";
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
 * Stand-in for the M2.03 mapper (#22, final interface at 2ba6a1a): one
 * `agent.connected` per hook with M2.03's ID shapes: `sourceEventId`
 * `<ctx.sourceEventId>:<event type>`, agent `claude-code:<session_id>` or
 * `claude-code:<session_id>:<agent_id>`, envelope `sessionId` the raw
 * `session_id`, `occurredAt` = `receivedAt`, `late` = `ctx.late`, and a context
 * `sourceEventId` over 170 characters ignored. Evidence is the raw tool input
 * and output, unredacted, as M2.03 returns it. Records every call.
 */
export function standInMapper(): ClaudeCodeMapper & { calls: MapContext[] } {
  const calls: MapContext[] = [];
  const mapper = (payload: unknown, ctx: MapContext) => {
    calls.push(ctx);
    const hook = payload as Record<string, unknown>;
    if (hook.hook_event_name === "Ignored") return { events: [], ignored: "not mapped" };
    if (ctx.sourceEventId.length > 170) return { events: [], ignored: "sourceEventId too long" };
    const session = String(hook.session_id);
    const agentId =
      typeof hook.agent_id === "string"
        ? `claude-code:${session}:${hook.agent_id}`
        : `claude-code:${session}`;
    return {
      events: [
        {
          schemaVersion: 1,
          projectId: ctx.projectId,
          sourceId: "claude-code",
          sourceEventId: `${ctx.sourceEventId}:agent.connected`,
          occurredAt: ctx.receivedAt,
          type: "agent.connected",
          agentId,
          sessionId: session,
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

/**
 * A stable lowercase UUID v4 for a test label, the only `sourceEventId` shape the
 * hooks route and the spool replay accept (what the shim generates).
 */
export function hookId(label: string): string {
  const h = createHash("sha256").update(label).digest("hex");
  const variant = "89ab"[Number.parseInt(h.charAt(16), 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
