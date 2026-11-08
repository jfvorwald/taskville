import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputEventWire } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assistantText,
  assistantToolUse,
  completeSession,
  fakeApiKey,
  jsonl,
  SESSION,
  T,
  toolResult,
  userPrompt,
} from "../../../../../packages/adapters/test/claude-code/transcripts/fixtures.ts";
import { createTranscriptImporter } from "../../../src/importers/transcripts/index.ts";
import type { ImportBatch, ImportContext, ImportCounts } from "../../../src/importers/types.ts";

// Transcript importer (M8.02, ARCHITECTURE.md 7.3, 13; imports design, "Transcripts").
// API under test: createTranscriptImporter() -> Importer with kind "transcripts". It reads
// `<config dir>/projects/<slug of root>/*.jsonl`, config dir = CLAUDE_CONFIG_DIR or ~/.claude
// (HOME-relative), read-only. The slug replaces every non-alphanumeric character with "-".
// Every test uses a temp config dir; the real ~/.claude is never read.

let tmp = "";
let configDir = "";
let root = "";
const saved = { config: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME };

const slugOf = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");
const projectDir = (r = root) => join(configDir, "projects", slugOf(r));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "taskville-m802-"));
  configDir = join(tmp, "claude-config");
  root = join(tmp, "work", "my.proj");
  mkdirSync(configDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.config;
  if (saved.home === undefined) delete process.env.HOME;
  else process.env.HOME = saved.home;
  rmSync(tmp, { recursive: true, force: true });
});

function write(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

interface Outcome {
  batches: ImportBatch[];
  events: InputEventWire[];
  evidence: NonNullable<ImportBatch["evidence"]>;
  counts: ImportCounts;
  progress: ImportCounts[];
}

async function drain(
  signal: AbortSignal = new AbortController().signal,
  onBatch?: () => void,
): Promise<Outcome> {
  const importer = createTranscriptImporter();
  const progress: ImportCounts[] = [];
  const context: ImportContext = {
    projectId: "proj-1",
    root,
    signal,
    progress: (c) => progress.push({ ...c }),
  };
  const batches: ImportBatch[] = [];
  const gen = importer.run(context);
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      return {
        batches,
        events: batches.flatMap((b) => b.events),
        evidence: batches.flatMap((b) => b.evidence ?? []),
        counts: next.value,
        progress,
      };
    }
    batches.push(next.value);
    onBatch?.();
  }
}

describe("importer identity", () => {
  it("is the transcripts importer", () => {
    expect(createTranscriptImporter().kind).toBe("transcripts");
  });
});

describe("a complete session on disk", () => {
  beforeEach(() => write(projectDir(), `${SESSION}.jsonl`, jsonl(completeSession())));

  it("yields imported transcript events with source-derived time and order", async () => {
    const { events, counts } = await drain();
    expect(events.length).toBeGreaterThan(8);
    for (const e of events) {
      expect(e.provenance).toBe("imported");
      expect(e.sourceId).toBe("claude-code:transcript");
      expect(e.projectId).toBe("proj-1");
    }
    const types = new Set(events.map((e) => e.type));
    for (const t of [
      "session.started",
      "session.prompt_submitted",
      "tool_call.started",
      "tool_call.finished",
      "session.turn_ended",
      "session.ended",
    ]) {
      expect(types, t).toContain(t);
    }
    const prompt = events.find((e) => e.type === "session.prompt_submitted");
    expect(prompt?.occurredAt).toBe(T(0));
    expect(prompt?.sourceSequence).toBe(1);
    expect(counts).toEqual({ read: 8, imported: events.length, skipped: 0, malformed: 0 });
  });

  it("reports progress and is stable across runs", async () => {
    const a = await drain();
    const b = await drain();
    expect(b.events.map((e) => e.sourceEventId)).toEqual(a.events.map((e) => e.sourceEventId));
    expect(new Set(a.events.map((e) => e.sourceEventId)).size).toBe(a.events.length);
    expect(a.progress.length).toBeGreaterThan(0);
    expect(a.progress.at(-1)).toEqual(a.counts);
  });

  it("returns evidence for tool calls", async () => {
    const { evidence } = await drain();
    expect(evidence.some((e) => e.toolCallId === "toolu_BASH" && e.input !== undefined)).toBe(true);
    expect(evidence.some((e) => e.toolCallId === "toolu_BASH" && e.output !== undefined)).toBe(
      true,
    );
  });

  it("does not modify the transcript", async () => {
    const before = jsonl(completeSession());
    write(projectDir(), "same.jsonl", before);
    await drain();
    expect(readFileSync(join(projectDir(), "same.jsonl"), "utf8")).toBe(before);
  });
});

describe("which files are read", () => {
  it("reads only the slug directory of the configured root", async () => {
    write(projectDir(), "a.jsonl", jsonl([userPrompt("mine", { ts: T(0) })]));
    write(
      projectDir(join(tmp, "work", "other")),
      "b.jsonl",
      jsonl([
        userPrompt("theirs", { ts: T(0), sessionId: "11111111-1111-4111-8111-111111111111" }),
      ]),
    );
    const { events, counts } = await drain();
    expect(counts.read).toBe(1);
    expect(events.every((e) => e.sessionId === SESSION)).toBe(true);
  });

  it("reads every .jsonl file there and ignores other files", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    write(projectDir(), "a.jsonl", jsonl([userPrompt("one", { ts: T(0) })]));
    write(projectDir(), "b.jsonl", jsonl([userPrompt("two", { ts: T(1), sessionId: other })]));
    write(projectDir(), "notes.txt", "not a transcript\n");
    const { events, counts } = await drain();
    expect(counts.read).toBe(2);
    expect(new Set(events.map((e) => e.sessionId))).toEqual(new Set([SESSION, other]));
  });

  it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset", async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = tmp;
    write(
      join(tmp, ".claude", "projects", slugOf(root)),
      "a.jsonl",
      jsonl([userPrompt("home", { ts: T(0) })]),
    );
    const { counts } = await drain();
    expect(counts.read).toBe(1);
  });

  it("yields zero events and zero counts when the directory is missing", async () => {
    const { batches, events, counts } = await drain();
    expect(events).toEqual([]);
    expect(batches.every((b) => b.events.length === 0)).toBe(true);
    expect(counts).toEqual({ read: 0, imported: 0, skipped: 0, malformed: 0 });
  });
});

describe("incomplete and malformed transcripts", () => {
  it("completes, counts malformed and skipped lines, and never throws", async () => {
    const lines: (object | string)[] = [
      userPrompt("start", { ts: T(0) }),
      "{this is not json",
      { type: "summary", summary: "A summary", leafUuid: "x" },
      { type: "hologram", timestamp: T(2) },
      assistantToolUse("toolu_X", "Bash", { command: "sleep 1" }, { ts: T(3) }),
      '{"type":"assistant","message":{"role":"assis',
    ];
    // The last line has no trailing newline, as in a file cut mid-write.
    write(
      projectDir(),
      "a.jsonl",
      lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"),
    );
    const { events, counts } = await drain();
    expect(counts.read).toBe(6);
    expect(counts.malformed).toBe(3);
    expect(counts.skipped).toBe(1);
    expect(counts.imported).toBe(events.length);
    expect(events.some((e) => e.type === "tool_call.started")).toBe(true);
    expect(events.some((e) => e.type === "tool_call.finished")).toBe(false);
    expect(events.some((e) => e.type === "session.ended")).toBe(false);
  });

  it("survives an unreadable-shaped file (binary junk)", async () => {
    write(projectDir(), "junk.jsonl", "\u0000\u0001\u0002\n��\n");
    const { counts } = await drain();
    expect(counts.read).toBe(2);
    expect(counts.malformed).toBe(2);
  });
});

describe("secrets and size", () => {
  it("masks secrets and bounds oversized text before yielding", async () => {
    const key = fakeApiKey();
    const huge = "y".repeat(1_000_000);
    write(
      projectDir(),
      "a.jsonl",
      jsonl([
        userPrompt(`please use ${key}`, { ts: T(0) }),
        assistantText(`using ${key}`, { ts: T(1) }),
        assistantToolUse("toolu_S", "Bash", { command: `API_KEY=${key} ./run` }, { ts: T(2) }),
        toolResult("toolu_S", `DATABASE_PASSWORD=${"hunter2hunter2"} ${key}`, { ts: T(3) }),
        assistantToolUse("toolu_H", "Bash", { command: huge }, { ts: T(4) }),
        toolResult("toolu_H", huge, { ts: T(5) }),
      ]),
    );
    const { events, evidence } = await drain();
    const all = JSON.stringify({ events, evidence });
    expect(all).not.toContain(key);
    expect(all).not.toContain("hunter2hunter2");
    expect(all).toContain("[REDACTED:anthropic-key]");
    expect(all).not.toContain("please use");
    for (const e of evidence) {
      expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(64 * 1024);
    }
  });
});

describe("cancellation", () => {
  it("stops before reading when already aborted", async () => {
    write(projectDir(), "a.jsonl", jsonl(completeSession()));
    const controller = new AbortController();
    controller.abort();
    const { events, counts } = await drain(controller.signal);
    expect(events).toEqual([]);
    expect(counts.read).toBe(0);
  });

  it("stops between batches when aborted mid-run", async () => {
    for (let i = 0; i < 6; i++) {
      const sid = `00000000-0000-4000-8000-${String(900 + i).padStart(12, "0")}`;
      write(
        projectDir(),
        `s${i}.jsonl`,
        jsonl([
          userPrompt("go", { ts: T(i), sessionId: sid }),
          assistantText("done", { ts: T(i + 1), sessionId: sid }, "end_turn"),
        ]),
      );
    }
    const full = await drain();
    const controller = new AbortController();
    const cut = await drain(controller.signal, () => controller.abort());
    expect(cut.events.length).toBeGreaterThan(0);
    expect(cut.events.length).toBeLessThan(full.events.length);
    expect(cut.counts.read).toBeLessThan(full.counts.read);
  });
});
