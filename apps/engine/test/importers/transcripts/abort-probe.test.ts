import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTranscriptImporter } from "../../../src/importers/transcripts/index.ts";
import type { ImportBatch, ImportContext } from "../../../src/importers/types.ts";

// M8.02 roborev 7451, medium: cancelling an import while the cwd probe reads a large transcript
// that has no cwd must stop promptly instead of reading the rest of the file. The file is sparse
// (a few GB of zero bytes, no newline, no cwd) so a full read takes seconds while the test uses
// no real disk. Temp dirs only; the real ~/.claude is never read.

let tmp = "";
const saved = process.env.CLAUDE_CONFIG_DIR;
const slugOf = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "taskville-m802a-"));
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-config");
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("abort during the cwd probe", () => {
  it("ends promptly and does not read the whole file", async () => {
    const root = join(tmp, "w", "app");
    const dir = join(process.env.CLAUDE_CONFIG_DIR as string, "projects", slugOf(root));
    mkdirSync(dir, { recursive: true });
    const fd = openSync(join(dir, "big.jsonl"), "w");
    ftruncateSync(fd, 6 * 1024 * 1024 * 1024);
    closeSync(fd);

    const controller = new AbortController();
    const context: ImportContext = {
      projectId: "proj-1",
      root,
      signal: controller.signal,
      progress: () => {},
    };
    const importer = createTranscriptImporter({ maxLineBytes: 64 * 1024 });
    const started = Date.now();
    setTimeout(() => controller.abort(), 30);
    const batches: ImportBatch[] = [];
    const gen = importer.run(context);
    let counts: Awaited<ReturnType<typeof gen.next>>["value"];
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        counts = next.value;
        break;
      }
      batches.push(next.value);
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1500);
    expect(batches.flatMap((b) => b.events)).toEqual([]);
    expect(counts).toMatchObject({ imported: 0 });
  }, 60_000);
});
