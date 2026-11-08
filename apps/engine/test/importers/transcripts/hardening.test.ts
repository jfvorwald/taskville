import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assistantToolUse,
  completeSession,
  fakeApiKey,
  jsonl as plainJsonl,
  SESSION,
  T,
  toolResult,
  userPrompt,
} from "../../../../../packages/adapters/test/claude-code/transcripts/fixtures.ts";
import { createTranscriptImporter } from "../../../src/importers/transcripts/index.ts";
import type { ImportBatch, ImportContext, ImportCounts } from "../../../src/importers/types.ts";

// Review-fix round for the transcript importer (M8.02, PR #468). Encodes: slug collisions are
// resolved by the first cwd of each file, files with no cwd are skipped, an over-long line is
// malformed without being buffered whole, sourceEventIds are file-scoped, and symlinks are never
// followed. Options encoded: createTranscriptImporter({ maxLineBytes }) caps one line (default
// 8 MiB). Every test uses a temp config dir; the real ~/.claude is never read.

let tmp = "";
let configDir = "";
let rootA = "";
let rootB = "";
const saved = process.env.CLAUDE_CONFIG_DIR;

const slugOf = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "taskville-m802h-"));
  configDir = join(tmp, "claude-config");
  // /w/my-app and /w/my/app share the slug "-w-my-app".
  rootA = join(tmp, "w", "my-app");
  rootB = join(tmp, "w", "my", "app");
  mkdirSync(configDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const dirFor = (root: string) => join(configDir, "projects", slugOf(root));

function put(root: string, name: string, content: string): string {
  const dir = dirFor(root);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

const withCwd = (lines: readonly object[], cwd: string | null): string =>
  plainJsonl(
    lines.map((l) => {
      const { cwd: _drop, ...rest } = l as Record<string, unknown>;
      return cwd === null ? rest : { ...rest, cwd };
    }),
  );

async function drain(
  root: string,
  options?: { maxLineBytes?: number },
): Promise<{ events: ImportBatch["events"]; evidence: unknown[]; counts: ImportCounts }> {
  const importer = (
    createTranscriptImporter as (o?: {
      maxLineBytes?: number;
    }) => ReturnType<typeof createTranscriptImporter>
  )(options);
  const context: ImportContext = {
    projectId: "proj-1",
    root,
    signal: new AbortController().signal,
    progress: () => {},
  };
  const batches: ImportBatch[] = [];
  const gen = importer.run(context);
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      return {
        events: batches.flatMap((b) => b.events),
        evidence: batches.flatMap((b) => b.evidence ?? []),
        counts: next.value,
      };
    }
    batches.push(next.value);
  }
}

const SESSION_B = "33333333-3333-4333-8333-333333333333";

describe("slug collisions", () => {
  it("imports only files whose first cwd is the root or inside it", async () => {
    // Both roots map to one directory, so both roots' sessions live side by side.
    put(rootA, "a.jsonl", withCwd([userPrompt("mine", { ts: T(0) })], rootA));
    put(
      rootA,
      "a-sub.jsonl",
      withCwd([userPrompt("inside", { ts: T(1), sessionId: SESSION_B })], join(rootA, "pkg")),
    );
    put(
      rootA,
      "b.jsonl",
      withCwd(
        [
          userPrompt("other project", {
            ts: T(2),
            sessionId: "44444444-4444-4444-8444-444444444444",
          }),
        ],
        rootB,
      ),
    );
    const { events, counts } = await drain(rootA);
    const sessions = new Set(events.map((e) => e.sessionId));
    expect(sessions).toEqual(new Set([SESSION, SESSION_B]));
    expect(sessions.has("44444444-4444-4444-8444-444444444444")).toBe(false);
    expect(counts.skipped).toBeGreaterThanOrEqual(1);
  });

  it("imports the other root's files for the other root", async () => {
    put(rootA, "a.jsonl", withCwd([userPrompt("mine", { ts: T(0) })], rootA));
    put(
      rootA,
      "b.jsonl",
      withCwd([userPrompt("theirs", { ts: T(2), sessionId: SESSION_B })], rootB),
    );
    const { events } = await drain(rootB);
    expect(new Set(events.map((e) => e.sessionId))).toEqual(new Set([SESSION_B]));
  });

  it("does not treat a sibling that merely shares a name prefix as inside the root", async () => {
    put(rootA, "a.jsonl", withCwd([userPrompt("sibling", { ts: T(0) })], `${rootA}-extra`));
    const { events, counts } = await drain(rootA);
    expect(events).toEqual([]);
    expect(counts.skipped).toBeGreaterThanOrEqual(1);
  });

  it("skips a file with no cwd at all and counts it skipped", async () => {
    put(rootA, "nocwd.jsonl", withCwd(completeSession(), null));
    const { events, counts } = await drain(rootA);
    expect(events).toEqual([]);
    expect(counts.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe("line cap", () => {
  it("counts an over-long line malformed and keeps importing", async () => {
    const huge = assistantToolUse(
      "toolu_HUGE",
      "Bash",
      { command: "x".repeat(200_000) },
      { ts: T(1) },
    );
    put(
      rootA,
      "a.jsonl",
      withCwd(
        [
          userPrompt("go", { ts: T(0) }),
          huge,
          assistantToolUse("toolu_AFTER", "Bash", { command: "ls" }, { ts: T(2) }),
        ],
        rootA,
      ),
    );
    const { events, counts } = await drain(rootA, { maxLineBytes: 64 * 1024 });
    const ids = events
      .filter((e) => e.type === "tool_call.started")
      .map((e) => e.payload.toolCallId);
    expect(ids).toEqual(["toolu_AFTER"]);
    expect(counts.read).toBe(3);
    expect(counts.malformed).toBe(1);
  });

  it("handles a single over-long line with no newline at the end of the file", async () => {
    const prompt = JSON.stringify({ ...userPrompt("go", { ts: T(0) }), cwd: rootA });
    const tail = JSON.stringify({
      ...assistantToolUse("toolu_T", "Bash", { command: "y".repeat(3_000_000) }, { ts: T(1) }),
      cwd: rootA,
    });
    put(rootA, "a.jsonl", `${prompt}\n${tail}`);
    const { events, counts } = await drain(rootA, { maxLineBytes: 1024 * 1024 });
    expect(events.some((e) => e.type === "tool_call.started")).toBe(false);
    expect(events.some((e) => e.type === "session.prompt_submitted")).toBe(true);
    expect(counts.malformed).toBe(1);
  });

  it("still masks a secret at the start of a large-but-allowed tool output", async () => {
    const key = fakeApiKey();
    put(
      rootA,
      "a.jsonl",
      withCwd(
        [
          assistantToolUse("toolu_B", "Bash", { command: "cat" }, { ts: T(0) }),
          toolResult("toolu_B", `${key} ${"z".repeat(5 * 1024 * 1024)}`, { ts: T(1) }),
        ],
        rootA,
      ),
    );
    const { events, evidence, counts } = await drain(rootA, { maxLineBytes: 8 * 1024 * 1024 });
    expect(counts.malformed).toBe(0);
    const all = JSON.stringify({ events, evidence });
    expect(all).not.toContain(key);
    for (const e of evidence) {
      expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(64 * 1024);
    }
    expect(all).toContain("[REDACTED:anthropic-key]");
  });
});

describe("file-scoped event ids", () => {
  it("imports two files that share a sessionId fully, with distinct sourceEventIds", async () => {
    put(rootA, "first.jsonl", withCwd(completeSession(), rootA));
    put(rootA, "second.jsonl", withCwd(completeSession(), rootA));
    const single = await (async () => {
      rmSync(join(dirFor(rootA), "second.jsonl"));
      return drain(rootA);
    })();
    put(rootA, "second.jsonl", withCwd(completeSession(), rootA));
    const both = await drain(rootA);
    expect(both.events).toHaveLength(single.events.length * 2);
    const ids = both.events.map((e) => e.sourceEventId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(String(id).length).toBeLessThanOrEqual(200);
    // Line 5 of each file is a distinct event.
    const line5 = both.events.filter((e) => e.sourceSequence === 5);
    expect(line5.length).toBeGreaterThanOrEqual(2);
    expect(new Set(line5.map((e) => e.sourceEventId)).size).toBe(line5.length);
    // Stable across runs.
    expect((await drain(rootA)).events.map((e) => e.sourceEventId)).toEqual(ids);
  });
});

describe("symlinks and key secrets", () => {
  it("skips a .jsonl that is a symlink and never reads its target", async () => {
    const outside = join(tmp, "outside.jsonl");
    writeFileSync(outside, withCwd(completeSession(), rootA));
    mkdirSync(dirFor(rootA), { recursive: true });
    symlinkSync(outside, join(dirFor(rootA), "link.jsonl"));
    const { events, counts } = await drain(rootA);
    expect(events).toEqual([]);
    expect(counts.read).toBe(0);
  });

  it("masks a secret used as an object key in a tool input", async () => {
    const key = fakeApiKey();
    put(
      rootA,
      "a.jsonl",
      withCwd(
        [
          assistantToolUse(
            "toolu_K",
            "Bash",
            { command: "env", env: { [key]: "v" } },
            { ts: T(0) },
          ),
        ],
        rootA,
      ),
    );
    const { events, evidence } = await drain(rootA);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify({ events, evidence })).not.toContain(key);
  });

  // NOT TESTED: a file swapped for a symlink between readdir and open. It needs a hook between
  // listing and open that the importer does not expose; the implementation should open with
  // O_NOFOLLOW (or lstat before and fstat after open) and the reviewer should confirm by reading.
});
