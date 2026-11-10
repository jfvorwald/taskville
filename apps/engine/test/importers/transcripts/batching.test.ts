import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assistantToolUse,
  jsonl,
  T,
  userPrompt,
} from "../../../../../packages/adapters/test/claude-code/transcripts/fixtures.ts";
import { createTranscriptImporter } from "../../../src/importers/transcripts/index.ts";
import type { ImportBatch } from "../../../src/importers/types.ts";

// M8.10 item 3 (issue #473, M8.02 finding L4): a batch is flushed on an event count threshold,
// not only per 500 lines or per bytes parsed. Here every line is small (well under the byte
// threshold) but carries many tool calls, so 20 lines make about 6000 events in one 500-line
// window. Required: the default event threshold is at most 1000, checked after each line, so no
// batch exceeds 1000 events plus one line's worth. Uses a temp config dir.

let tmp = "";
let root = "";
const saved = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "taskville-m810b-"));
  root = join(tmp, "w", "app");
  mkdirSync(root, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-config");
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const CALLS_PER_LINE = 300;
const LINES = 20;

describe("event-count batch flush", () => {
  it("yields batches of at most 1000 events plus one line", async () => {
    const dir = join(
      process.env.CLAUDE_CONFIG_DIR as string,
      "projects",
      root.replace(/[^A-Za-z0-9]/g, "-"),
    );
    mkdirSync(dir, { recursive: true });
    const lines: object[] = [userPrompt("go", { ts: T(0), cwd: root })];
    for (let i = 0; i < LINES; i += 1) {
      // One assistant line with many tool_use blocks (each is one tool_call.started event).
      const blocks = Array.from({ length: CALLS_PER_LINE }, (_, j) => ({
        type: "tool_use",
        id: `toolu_${i}_${j}`,
        name: "Read",
        input: { file_path: "a" },
      }));
      const line = assistantToolUse("x", "Read", {}, { ts: T(i + 1), cwd: root }) as {
        message: { content: unknown[] };
      };
      line.message.content = blocks;
      lines.push(line);
    }
    writeFileSync(join(dir, "session.jsonl"), jsonl(lines));

    const gen = createTranscriptImporter().run({
      projectId: "proj-1",
      root,
      signal: new AbortController().signal,
      progress: () => {},
    });
    const batches: ImportBatch[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      batches.push(next.value);
    }

    const total = batches.reduce((n, b) => n + b.events.length, 0);
    expect(total).toBeGreaterThanOrEqual(CALLS_PER_LINE * LINES);
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches.map((b) => b.events.length))).toBeLessThanOrEqual(
      1000 + CALLS_PER_LINE + 2,
    );
  });
});

describe("review M2: a line with an enormous number of blocks", () => {
  it("completes the import instead of overflowing a spread", async () => {
    const dir = join(
      process.env.CLAUDE_CONFIG_DIR as string,
      "projects",
      root.replace(/[^A-Za-z0-9]/g, "-"),
    );
    mkdirSync(dir, { recursive: true });
    const first = JSON.stringify(userPrompt("go", { ts: T(0), cwd: root }));
    const line = assistantToolUse("x", "Read", {}, { ts: T(1), cwd: root }) as {
      message: { content: unknown[] };
    };
    // About 6.6 MB: under the 8 MiB line cap, with far more blocks than a spread can take.
    line.message.content = Array.from({ length: 160_000 }, () => ({
      type: "tool_use",
      id: "t",
      name: "R",
    }));
    writeFileSync(join(dir, "session.jsonl"), `${first}\n${JSON.stringify(line)}\n`);

    const gen = createTranscriptImporter().run({
      projectId: "proj-1",
      root,
      signal: new AbortController().signal,
      progress: () => {},
    });
    const batches: ImportBatch[] = [];
    let counts: unknown;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        counts = next.value;
        break;
      }
      batches.push(next.value);
    }
    expect((counts as { read: number }).read).toBe(2);
    expect(Math.max(...batches.map((b) => b.events.length))).toBeLessThanOrEqual(1_100);
  }, 60_000);
});

describe("roborev 7754: a long prefix without a cwd", () => {
  it("skips the file after one batch instead of buffering the whole prefix", async () => {
    const dir = join(
      process.env.CLAUDE_CONFIG_DIR as string,
      "projects",
      root.replace(/[^A-Za-z0-9]/g, "-"),
    );
    mkdirSync(dir, { recursive: true });
    // 2,000 cwd-free lines (more than one 500-line batch), then a line inside the root.
    const lines: object[] = Array.from({ length: 2_000 }, (_, i) =>
      userPrompt(`p${i}`, { ts: T(i), cwd: null }),
    );
    lines.push(userPrompt("late", { ts: T(2_001), cwd: root }));
    writeFileSync(join(dir, "session.jsonl"), jsonl(lines));

    const gen = createTranscriptImporter().run({
      projectId: "proj-1",
      root,
      signal: new AbortController().signal,
      progress: () => {},
    });
    const batches: ImportBatch[] = [];
    let counts: { skipped: number; imported: number } | undefined;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        counts = next.value as { skipped: number; imported: number };
        break;
      }
      batches.push(next.value);
    }
    expect(batches.reduce((n, b) => n + b.events.length, 0)).toBe(0);
    expect(counts?.imported).toBe(0);
    expect(counts?.skipped).toBe(1);
  });
});
