import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ToolEvidence } from "@taskville/adapters/claude-code";
import {
  createTranscriptMapper,
  transcriptSlug,
} from "@taskville/adapters/claude-code/transcripts";
import type { ImportBatch, ImportContext, ImportCounts, Importer } from "../types.ts";

// Transcript importer (M8.02, imports design "Transcripts"). Reads the Claude Code session
// transcripts of one configured root, `<config dir>/projects/<slug of root>/*.jsonl`, read-only.
// The config dir is CLAUDE_CONFIG_DIR or ~/.claude. Lines are streamed, mapped by the pure
// adapter mapper, and yielded in batches; the job runner stores them.

/** Lines mapped before a batch is yielded, which is also how often abort is checked. */
const BATCH_LINES = 500;

const configDir = (): string => {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(homedir(), ".claude");
};

async function transcriptFiles(root: string): Promise<string[]> {
  const dir = join(configDir(), "projects", transcriptSlug(root));
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

export function createTranscriptImporter(): Importer {
  return {
    kind: "transcripts",
    async *run(context: ImportContext): AsyncGenerator<ImportBatch, ImportCounts, void> {
      const counts: ImportCounts = { read: 0, imported: 0, skipped: 0, malformed: 0 };
      const report = () => context.progress({ ...counts });
      if (context.signal.aborted) {
        report();
        return counts;
      }
      for (const file of await transcriptFiles(context.root)) {
        if (context.signal.aborted) break;
        const mapper = createTranscriptMapper({ projectId: context.projectId });
        let batch: ImportBatch = { events: [] };
        let lines = 0;
        let lineNumber = 0;
        const take = (result: { events: ImportBatch["events"]; evidence?: ToolEvidence[] }) => {
          batch.events.push(...result.events);
          if (result.evidence !== undefined) {
            batch.evidence = [...(batch.evidence ?? []), ...result.evidence];
          }
          counts.imported += result.events.length;
        };
        const reader = createInterface({
          input: createReadStream(file, { encoding: "utf8" }),
          crlfDelay: Number.POSITIVE_INFINITY,
        });
        let aborted = false;
        try {
          for await (const raw of reader) {
            lineNumber += 1;
            counts.read += 1;
            const result = mapper.mapLine(raw, lineNumber);
            if (result.outcome === "skipped") counts.skipped += 1;
            if (result.outcome === "malformed") counts.malformed += 1;
            take(result);
            lines += 1;
            if (lines >= BATCH_LINES) {
              report();
              yield batch;
              batch = { events: [] };
              lines = 0;
              if (context.signal.aborted) {
                aborted = true;
                break;
              }
            }
          }
        } finally {
          reader.close();
        }
        // A cancelled file is partial, so no session end is inferred from it.
        if (aborted) break;
        take(mapper.finish());
        report();
        yield batch;
      }
      report();
      return counts;
    },
  };
}
