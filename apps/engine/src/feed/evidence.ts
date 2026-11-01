import type { ToolCallPhase } from "@taskville/protocol";
import type { Context, Hono } from "hono";
import { type BodyPart, EVICTED_MESSAGE, type EvidenceStore } from "../evidence/index.ts";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";

/** A body a feed frame points at. `evicted` means the call happened but its details are gone. */
export interface EvidenceRef {
  id: string;
  status: "stored" | "evicted";
}

export interface FrameEvidence {
  input: EvidenceRef | null;
  output: EvidenceRef | null;
}

/** `GET /v1/evidence/:id` (200). */
export interface EvidenceResponse {
  id: string;
  projectId: string;
  toolCallId: string;
  part: BodyPart;
  /** The stored, already redacted body as plain text. Never HTML, never HTML-escaped. */
  text: string;
  /** Where each `[REDACTED:kind]` marker sits in `text`: UTF-16 offsets, `[start, end)`, sorted. */
  masks: { start: number; end: number; kind: string }[];
  truncated: boolean;
  bytes: number;
}

/**
 * An evidence ID names a body by project, ToolCall, and part, so it resolves in one project only
 * and the store needs no extra index. It is opaque to clients: base64url of a JSON array.
 */
export function evidenceId(projectId: string, toolCallId: string, part: BodyPart): string {
  return Buffer.from(JSON.stringify([projectId, toolCallId, part]), "utf8").toString("base64url");
}

/** The parts of an ID made by `evidenceId`, or undefined for anything else (strictly checked). */
export function parseEvidenceId(
  id: string,
): { projectId: string; toolCallId: string; part: BodyPart } | undefined {
  if (id.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
  const [projectId, toolCallId, part] = parsed as unknown[];
  if (typeof projectId !== "string" || typeof toolCallId !== "string") return undefined;
  if (part !== "input" && part !== "output") return undefined;
  // Only the canonical form counts, so one body has one ID.
  if (evidenceId(projectId, toolCallId, part) !== id) return undefined;
  return { projectId, toolCallId, part };
}

/**
 * The evidence references of a ToolCall as of its frame: the input always, the output only once
 * the call has finished (a running call has no output yet, whatever the store holds now). The
 * status of each is the store's, current when the frame is written.
 */
export function frameEvidence(
  store: EvidenceStore,
  projectId: string,
  toolCallId: string,
  phase: ToolCallPhase,
): FrameEvidence {
  const bodies = store.get(projectId, toolCallId);
  const ref = (part: BodyPart): EvidenceRef | null => {
    const body = bodies?.[part];
    if (body === null || body === undefined) return null;
    return { id: evidenceId(projectId, toolCallId, part), status: body.status };
  };
  return { input: ref("input"), output: phase === "running" ? null : ref("output") };
}

const MARKER = /\[REDACTED:([a-z-]+)\]/g;

/** The masks of a stored body: only a body the redactor changed has any. */
function masksOf(text: string, masked: boolean): EvidenceResponse["masks"] {
  if (!masked) return [];
  return [...text.matchAll(MARKER)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    kind: m[1] as string,
  }));
}

/** `GET /v1/evidence/:id` (contracts/http-api.md): one stored tool call body, as plain JSON text. */
export function registerEvidenceRoute(app: Hono<AppEnv>, store: EvidenceStore): void {
  app.get("/v1/evidence/:id", requireScope("read"), (c: Context<AppEnv>) => {
    const unknown = () => apiError(c, 404, "unknown_evidence", "No evidence with this ID");
    const id = c.req.param("id") ?? "";
    const parsed = parseEvidenceId(id);
    if (parsed === undefined) return unknown();
    const body = store.get(parsed.projectId, parsed.toolCallId)?.[parsed.part];
    if (body === null || body === undefined) return unknown();
    if (body.status === "evicted") return apiError(c, 410, "evidence_evicted", EVICTED_MESSAGE);
    const response: EvidenceResponse = {
      id,
      projectId: parsed.projectId,
      toolCallId: parsed.toolCallId,
      part: parsed.part,
      text: body.text,
      masks: masksOf(body.text, body.masked),
      truncated: body.truncated,
      bytes: body.bytes,
    };
    return c.json(response);
  });
}
