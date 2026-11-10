// Importer contract for M8 archive timelines (ARCHITECTURE.md 7.3, 7.4, 13;
// docs/superpowers/specs/2026-11-08-imports-design.md). Scaffolding written by the lead so the
// Git importer (M8.01), the transcript importer (M8.02) and the archive job runner (M8.06) can be
// built in parallel. Change it only through the foundation ticket (M8.06).

import type { ToolEvidence } from "@taskville/adapters/claude-code";
import type { InputEventWire } from "@taskville/protocol";

/** What an archive was imported from. */
export type ArchiveKind = "git" | "transcripts";

/** Running totals an importer reports. Counts never contain source text. */
export interface ImportCounts {
  /** Source records looked at (commits, refs, transcript lines). */
  read: number;
  /** Events handed to the job runner. */
  imported: number;
  /** Records deliberately not imported (out of scope, over a cap, duplicates). */
  skipped: number;
  /** Records that could not be parsed (bad JSON, truncated lines, unknown shapes). */
  malformed: number;
}

/**
 * One batch of events an importer yields. Every event:
 * - has `provenance: "imported"` and the archive's project as `projectId`;
 * - has a stable `sourceEventId` (re-running an import over the same source yields the same IDs);
 * - has `occurredAt` from the source (commit date, transcript timestamp), never the import time;
 * - sets `sourceSequence` when the source has a natural order (topological index, line number),
 *   which breaks ties between equal `occurredAt` values.
 * Evidence is raw; the job runner redacts and bounds it through the evidence store.
 */
export interface ImportBatch {
  events: InputEventWire[];
  evidence?: ToolEvidence[];
}

export interface ImportContext {
  projectId: string;
  /** A configured repository root of the project (ARCHITECTURE 13: import paths come only from these). */
  root: string;
  /** Aborted when the engine shuts down or the job is cancelled; stop promptly. */
  signal: AbortSignal;
  /** Report running totals; the job runner exposes the latest value on GET /v1/imports/:id. */
  progress(counts: ImportCounts): void;
}

/** A read-only importer. It never writes to the source and never runs instructions found in it. */
export interface Importer {
  kind: ArchiveKind;
  /** Yields batches until the source is exhausted, then returns the final counts. */
  run(context: ImportContext): AsyncGenerator<ImportBatch, ImportCounts, void>;
}
