import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  jsonl,
  T,
  userPrompt,
} from "../../../../../packages/adapters/test/claude-code/transcripts/fixtures.ts";
import { createTranscriptImporter } from "../../../src/importers/transcripts/index.ts";
import type { ImportBatch } from "../../../src/importers/types.ts";

// M8.12 (issue #485): the transcript importer yields a batch on bytes parsed as well as every 500
// lines, so a file of a few very long lines does not hold the event loop for one huge batch.
// Option encoded: createTranscriptImporter({ yieldBytes }) - bytes parsed between yields, default
// 4 MiB. Uses a temp config dir; the real ~/.claude is never read.

let tmp = "";
let root = "";
const saved = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "taskville-m812-"));
  root = join(tmp, "w", "app");
  mkdirSync(root, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-config");
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(tmp, { recursive: true, force: true });
});

/** One session file of `count` prompts, each about `lineBytes` long, started in the root. */
function writeSession(count: number, lineBytes: number): void {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR as string,
    "projects",
    root.replace(/[^A-Za-z0-9]/g, "-"),
  );
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) =>
    userPrompt(`${i}:${"x".repeat(lineBytes)}`, { ts: T(i), cwd: root }),
  );
  writeFileSync(join(dir, "session.jsonl"), jsonl(lines));
}

async function batchesOf(options?: { yieldBytes?: number }): Promise<ImportBatch[]> {
  const importer = (
    createTranscriptImporter as (o?: {
      yieldBytes?: number;
    }) => ReturnType<typeof createTranscriptImporter>
  )(options);
  const gen = importer.run({
    projectId: "proj-1",
    root,
    signal: new AbortController().signal,
    progress: () => {},
  });
  const batches: ImportBatch[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return batches;
    batches.push(next.value);
  }
}

describe("transcript importer byte-based yielding", () => {
  it("yields more than one batch for a few long lines when yieldBytes is small", async () => {
    // 6 lines (far under 500) of about 100 KB each: 600 KB against a 128 KiB budget.
    writeSession(6, 100_000);
    const batches = await batchesOf({ yieldBytes: 128 * 1024 });
    expect(batches.length).toBeGreaterThan(2);
    expect(batches.flatMap((b) => b.events).length).toBeGreaterThanOrEqual(6);
  });

  it("yields on the 4 MiB default: three 3 MiB lines are not one batch", async () => {
    writeSession(3, 3 * 1024 * 1024);
    const batches = await batchesOf();
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((b) => b.events).length).toBeGreaterThanOrEqual(3);
  });

  it("still yields one batch for a small file", async () => {
    writeSession(3, 100);
    const batches = await batchesOf({ yieldBytes: 128 * 1024 });
    expect(batches.length).toBe(1);
    expect(batches[0]?.events.length).toBeGreaterThanOrEqual(3);
  });
});
