import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// M8.18 (issue #529, roborev 7747 medium, M8.10 security review L1): a file truncated and
// rewritten in place keeps its inode, so the dev and ino comparison does not see it. The rewrite
// is simulated through the node:fs/promises `open` seam: right after the first read of the
// transcript's first handle (the cwd probe), the file is rewritten in place (same inode) with a
// first cwd outside the root. Required: no content whose cwd was not the validated one is
// imported, whether by reading through one descriptor and validating what is read, or otherwise.
// Uses a temp config dir; the real ~/.claude is never read.

const state = vi.hoisted(() => ({
  target: "",
  rewrite: undefined as (() => void) | undefined,
  opens: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) !== state.target) return handle;
      state.opens += 1;
      if (state.opens === 1) {
        const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
        let done = false;
        (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
          const result = await read(...a);
          if (!done) {
            done = true;
            state.rewrite?.();
          }
          return result;
        };
      }
      return handle;
    }) as typeof actual.open,
  };
});

let tmp = "";
let root = "";
const saved = process.env.CLAUDE_CONFIG_DIR;
const HOSTILE_SESSION = "88888888-8888-4888-8888-888888888888";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "taskville-m818r-"));
  root = join(tmp, "w", "app");
  mkdirSync(root, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-config");
  state.target = "";
  state.rewrite = undefined;
  state.opens = 0;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("a transcript rewritten in place after the cwd probe", () => {
  it("never imports content whose cwd was not the validated one", async () => {
    const dir = join(
      process.env.CLAUDE_CONFIG_DIR as string,
      "projects",
      root.replace(/[^A-Za-z0-9]/g, "-"),
    );
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.jsonl");
    writeFileSync(file, jsonl([userPrompt("in root", { ts: T(0), cwd: root })]));

    state.target = file;
    // writeFileSync on the existing path truncates and rewrites it: the inode is unchanged.
    state.rewrite = () =>
      writeFileSync(
        file,
        jsonl([
          userPrompt("other project", {
            ts: T(1),
            cwd: join(tmp, "elsewhere"),
            sessionId: HOSTILE_SESSION,
          }),
        ]),
      );

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
    expect(sessions.has(HOSTILE_SESSION)).toBe(false);
    for (const s of sessions) expect(s).toBe(SESSION);
  });
});
