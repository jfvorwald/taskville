import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  jsonl,
  SESSION,
  T,
  userPrompt,
} from "../../../../../packages/adapters/test/claude-code/transcripts/fixtures.ts";
import { createTranscriptImporter } from "../../../src/importers/transcripts/index.ts";
import type { ImportBatch } from "../../../src/importers/types.ts";

// M8.21 (issue #537, M8.20 security review L2). A session registered without a cwd keeps
// session.started {}; its first later cwd must still be checked against the root. Decision
// encoded: when that first cwd is outside the root the importer stops the file there (as it does
// for any outside session cwd), so no event of that session at or after the outside line is
// imported. Temp dirs only; fixtures are synthetic.

let tmp = "";
let root = "";
let outside = "";
const saved = process.env.CLAUDE_CONFIG_DIR;
const OTHER = "2f6c1d2e-0000-4000-8000-0000000000b2";

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "taskville-m821-")));
  root = join(tmp, "w", "app");
  outside = join(tmp, "elsewhere");
  mkdirSync(join(root, "sub"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-config");
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(tmp, { recursive: true, force: true });
});

function put(content: string): void {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR as string,
    "projects",
    root.replace(/[^A-Za-z0-9]/g, "-"),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), content);
}

async function runImport(): Promise<ImportBatch[]> {
  const importer = createTranscriptImporter();
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

const events = (batches: ImportBatch[]) => batches.flatMap((b) => b.events);
const outsideFolders = (batches: ImportBatch[]): string[] =>
  events(batches)
    .map((e) => (e.payload as { workingDirectory?: string }).workingDirectory)
    .filter((d): d is string => d !== undefined && d !== "" && !d.startsWith(root));
/** Events of `sessionId` from line `from` on (sourceSequence is the 1-based line number). */
const sessionEventsFrom = (batches: ImportBatch[], sessionId: string, from: number) =>
  events(batches).filter(
    (e) => (e as { sessionId?: string }).sessionId === sessionId && (e.sourceSequence ?? 0) >= from,
  );

const system = (cwd: string) => ({ type: "system", cwd, sessionId: SESSION, timestamp: T(0) });

describe("a session registered without a cwd, then an outside cwd", () => {
  it("imports nothing of that session from the outside line on (file validated by a session line)", async () => {
    put(
      jsonl([
        userPrompt("a", { ts: T(0), cwd: root, sessionId: SESSION }),
        userPrompt("b", { ts: T(1), cwd: null, sessionId: OTHER }),
        userPrompt("c", { ts: T(2), cwd: outside, sessionId: OTHER }),
        userPrompt("d", { ts: T(3), cwd: outside, sessionId: OTHER }),
      ]),
    );
    const batches = await runImport();
    expect(outsideFolders(batches)).toEqual([]);
    expect(JSON.stringify(batches)).not.toContain(outside);
    expect(sessionEventsFrom(batches, OTHER, 3)).toEqual([]);
  });

  it("imports nothing from the outside line when only a system line validated the file", async () => {
    put(
      jsonl([
        system(root),
        userPrompt("b", { ts: T(1), cwd: null, sessionId: OTHER }),
        userPrompt("c", { ts: T(2), cwd: outside, sessionId: OTHER }),
      ]),
    );
    const batches = await runImport();
    expect(outsideFolders(batches)).toEqual([]);
    expect(JSON.stringify(batches)).not.toContain(outside);
    expect(sessionEventsFrom(batches, OTHER, 3)).toEqual([]);
  });

  it("imports nothing from the outside line when only a summary line validated the file", async () => {
    put(
      jsonl([
        { type: "summary", summary: "s", cwd: root, leafUuid: "x" },
        userPrompt("b", { ts: T(1), cwd: null, sessionId: OTHER }),
        userPrompt("c", { ts: T(2), cwd: outside, sessionId: OTHER }),
      ]),
    );
    const batches = await runImport();
    expect(outsideFolders(batches)).toEqual([]);
    expect(sessionEventsFrom(batches, OTHER, 3)).toEqual([]);
  });
});

describe("a skipped-type line carrying an awaiting session's first cwd (roborev 7807)", () => {
  for (const type of ["system", "summary"]) {
    it(`imports nothing of that session from an outside ${type} line on`, async () => {
      put(
        jsonl([
          userPrompt("a", { ts: T(0), cwd: root, sessionId: SESSION }),
          userPrompt("b", { ts: T(1), cwd: null, sessionId: OTHER }),
          { type, sessionId: OTHER, cwd: outside, timestamp: T(2), summary: "s", leafUuid: "x" },
          userPrompt("c", { ts: T(3), cwd: null, sessionId: OTHER }),
          userPrompt("d", { ts: T(4), cwd: root, sessionId: OTHER }),
        ]),
      );
      const batches = await runImport();
      expect(JSON.stringify(batches)).not.toContain(outside);
      expect(sessionEventsFrom(batches, OTHER, 3)).toEqual([]);
    });
  }
});

// roborev 7824. cleanText cuts a path to 4,096 code points, so a long path can have a cleaned
// prefix inside the root while the raw path resolves outside. The raw cwd must be checked too.
// The sessionCwd case is covered for a registering line in an already validated file (as the
// first line of the file, the raw cwd already validates the file).
const longEscape = (): string => `${root}/${"a/".repeat(2100)}${"../".repeat(2100 + 3)}../outside`;

describe("a long cwd whose truncated value is inside the root but whose raw path is outside (roborev 7824)", () => {
  it("imports nothing of a cwd-less session from the line whose raw first cwd is outside", async () => {
    const long = longEscape();
    expect(Array.from(long).length).toBeGreaterThan(4096);
    put(
      jsonl([
        userPrompt("a", { ts: T(0), cwd: root, sessionId: SESSION }),
        userPrompt("b", { ts: T(1), cwd: null, sessionId: OTHER }),
        userPrompt("c", { ts: T(2), cwd: long, sessionId: OTHER }),
        userPrompt("d", { ts: T(3), cwd: null, sessionId: OTHER }),
        userPrompt("e", { ts: T(4), cwd: root, sessionId: OTHER }),
      ]),
    );
    const batches = await runImport();
    expect(sessionEventsFrom(batches, OTHER, 3)).toEqual([]);
  });

  it("imports nothing from a registering line whose raw session cwd is outside, in a validated file", async () => {
    const long = longEscape();
    put(
      jsonl([
        userPrompt("a", { ts: T(0), cwd: root, sessionId: SESSION }),
        userPrompt("b", { ts: T(1), cwd: long, sessionId: OTHER }),
        userPrompt("c", { ts: T(2), cwd: root, sessionId: OTHER }),
      ]),
    );
    const batches = await runImport();
    expect(sessionEventsFrom(batches, OTHER, 2)).toEqual([]);
  });

  it("still imports a long first cwd whose raw path stays inside the root", async () => {
    const long = `${root}/${"a/".repeat(2100)}${"../".repeat(2100)}sub`;
    put(
      jsonl([
        userPrompt("a", { ts: T(0), cwd: root, sessionId: SESSION }),
        userPrompt("b", { ts: T(1), cwd: null, sessionId: OTHER }),
        userPrompt("c", { ts: T(2), cwd: long, sessionId: OTHER }),
      ]),
    );
    const batches = await runImport();
    expect(sessionEventsFrom(batches, OTHER, 3).length).toBeGreaterThan(0);
  });
});

describe("controls", () => {
  it("imports a session registered without a cwd whose first later cwd is inside the root", async () => {
    put(
      jsonl([
        system(root),
        userPrompt("b", { ts: T(1), cwd: null, sessionId: OTHER }),
        userPrompt("c", { ts: T(2), cwd: join(root, "sub"), sessionId: OTHER }),
        userPrompt("d", { ts: T(3), cwd: root, sessionId: OTHER }),
      ]),
    );
    const batches = await runImport();
    expect(sessionEventsFrom(batches, OTHER, 4).length).toBeGreaterThan(0);
    expect(sessionEventsFrom(batches, OTHER, 3).length).toBeGreaterThan(0);
  });

  it("does not reject a session whose cwd later changes after the first one", async () => {
    put(
      jsonl([
        userPrompt("a", { ts: T(0), cwd: root, sessionId: SESSION }),
        userPrompt("b", { ts: T(1), cwd: join(root, "sub"), sessionId: SESSION }),
        userPrompt("c", { ts: T(2), cwd: outside, sessionId: SESSION }),
      ]),
    );
    const batches = await runImport();
    expect(sessionEventsFrom(batches, SESSION, 3).length).toBeGreaterThan(0);
  });

  it("does not reject a later cwd change after a cwd-less start once the first cwd was inside", async () => {
    put(
      jsonl([
        userPrompt("a", { ts: T(0), cwd: null, sessionId: OTHER }),
        userPrompt("b", { ts: T(1), cwd: root, sessionId: OTHER }),
        userPrompt("c", { ts: T(2), cwd: outside, sessionId: OTHER }),
      ]),
    );
    const batches = await runImport();
    expect(sessionEventsFrom(batches, OTHER, 3).length).toBeGreaterThan(0);
  });

  it("imports a session's later events when a skipped line carries an in-root first cwd", async () => {
    put(
      jsonl([
        userPrompt("a", { ts: T(0), cwd: root, sessionId: SESSION }),
        userPrompt("b", { ts: T(1), cwd: null, sessionId: OTHER }),
        { type: "system", sessionId: OTHER, cwd: join(root, "sub"), timestamp: T(2) },
        userPrompt("c", { ts: T(3), cwd: null, sessionId: OTHER }),
        userPrompt("d", { ts: T(4), cwd: root, sessionId: OTHER }),
      ]),
    );
    const batches = await runImport();
    expect(sessionEventsFrom(batches, OTHER, 4).length).toBeGreaterThan(0);
  });
});
