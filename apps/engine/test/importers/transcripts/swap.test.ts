import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jsonl,
  SESSION,
  T,
  userPrompt,
} from "../../../../../packages/adapters/test/claude-code/transcripts/fixtures.ts";
import { createTranscriptImporter } from "../../../src/importers/transcripts/index.ts";
import type { ImportBatch } from "../../../src/importers/types.ts";

// M8.10 item 1 (issue #473, M8.02 finding L2): the cwd probe and the import open the file
// separately, so a regular file swapped in between them could bypass the root scope. The swap is
// simulated by wrapping node:fs/promises `open`: just before the SECOND open of the transcript
// path, a different regular file (new inode, cwd outside the root) is renamed over it.
// Required: the import either reuses the probe's handle (never reopens) or compares dev and ino of
// the two handles and skips on a mismatch. Either way no event of the swapped file is imported.
// Uses a temp config dir; the real ~/.claude is never read.

const swapState = vi.hoisted(() => ({
  target: "",
  swapIn: undefined as (() => void) | undefined,
  opens: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === swapState.target) {
        swapState.opens += 1;
        if (swapState.opens === 2) swapState.swapIn?.();
      }
      return actual.open(...args);
    }) as typeof actual.open,
  };
});

let tmp = "";
let root = "";
const saved = process.env.CLAUDE_CONFIG_DIR;
const SWAPPED_SESSION = "99999999-9999-4999-8999-999999999999";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "taskville-m810s-"));
  root = join(tmp, "w", "app");
  mkdirSync(root, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-config");
  swapState.target = "";
  swapState.swapIn = undefined;
  swapState.opens = 0;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("a regular file swapped between the cwd probe and the import", () => {
  it("never imports the swapped-in file's events", async () => {
    const dir = join(
      process.env.CLAUDE_CONFIG_DIR as string,
      "projects",
      root.replace(/[^A-Za-z0-9]/g, "-"),
    );
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.jsonl");
    writeFileSync(file, jsonl([userPrompt("in root", { ts: T(0), cwd: root })]));

    // The replacement lives outside the root: its cwd is another project.
    const replacement = join(tmp, "replacement.jsonl");
    writeFileSync(
      replacement,
      jsonl([
        userPrompt("other project", {
          ts: T(1),
          cwd: join(tmp, "elsewhere"),
          sessionId: SWAPPED_SESSION,
        }),
      ]),
    );
    swapState.target = file;
    swapState.swapIn = () => renameSync(replacement, file);

    const importer = createTranscriptImporter();
    const batches: ImportBatch[] = [];
    const gen = importer.run({
      projectId: "proj-1",
      root,
      signal: new AbortController().signal,
      progress: () => {},
    });
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      batches.push(next.value);
    }

    const sessions = new Set(batches.flatMap((b) => b.events.map((e) => e.sessionId)));
    expect(sessions.has(SWAPPED_SESSION)).toBe(false);
    // The original session is either imported (one handle reused) or skipped (ino mismatch).
    for (const s of sessions) expect(s).toBe(SESSION);
  });
});
