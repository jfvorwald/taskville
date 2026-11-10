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
import type { ImportBatch, ImportCounts } from "../../../src/importers/types.ts";

// M8.20 (issue #533, M8.18 security review F1 to F4). Temp config dir only; fixtures are
// synthetic.
//
// Option encoded: createTranscriptImporter({ onSkip }) calls onSkip({ reason }) once for each file
// it skips, with reason "outside-root" for a file whose session cwd is outside the root and
// "no-cwd-in-allowance" for a file that shows no cwd within the pre-validation allowance (the
// counts type has no field for a reason, and its owner is another ticket, so the importer reports
// the reason through this callback).

let tmp = "";
let root = "";
let outside = "";
const saved = process.env.CLAUDE_CONFIG_DIR;
const OTHER = "2f6c1d2e-0000-4000-8000-0000000000b2";

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "taskville-m820-")));
  root = join(tmp, "w", "app");
  outside = join(tmp, "elsewhere");
  mkdirSync(root, { recursive: true });
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

interface Outcome {
  batches: ImportBatch[];
  counts: ImportCounts;
  skips: { reason: string }[];
}

async function runImport(signal: AbortSignal = new AbortController().signal): Promise<Outcome> {
  const skips: { reason: string }[] = [];
  const importer = createTranscriptImporter({
    onSkip: (skip: { reason: string }) => skips.push(skip),
  } as Parameters<typeof createTranscriptImporter>[0]);
  const gen = importer.run({ projectId: "proj-1", root, signal, progress: () => {} });
  const batches: ImportBatch[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { batches, counts: next.value, skips };
    batches.push(next.value);
  }
}

const workingDirectories = (batches: ImportBatch[]): string[] =>
  batches
    .flatMap((b) => b.events)
    .filter((e) => e.type === "session.started")
    .map((e) => (e.payload as { workingDirectory?: string }).workingDirectory ?? "");

describe("F1: an escaped cwd key", () => {
  it("does not import a session whose cwd is outside the root", async () => {
    const escaped = JSON.stringify(userPrompt("first", { ts: T(0), cwd: outside })).replace(
      '"cwd"',
      '"\\u0063wd"',
    );
    expect(escaped).not.toContain('"cwd"');
    put(`${escaped}\n${jsonl([userPrompt("second", { ts: T(1), cwd: root })])}`);

    const { batches } = await runImport();
    expect(workingDirectories(batches).filter((d) => !d.startsWith(root))).toEqual([]);
    expect(JSON.stringify(batches)).not.toContain(outside);
  });
});

describe("F2: a later session with an outside cwd", () => {
  it("imports no event with a working directory outside the root", async () => {
    put(
      jsonl([
        userPrompt("a", { ts: T(0), cwd: root, sessionId: SESSION }),
        userPrompt("b", { ts: T(1), cwd: outside, sessionId: OTHER }),
      ]),
    );

    const { batches } = await runImport();
    expect(workingDirectories(batches).filter((d) => !d.startsWith(root))).toEqual([]);
    expect(JSON.stringify(batches)).not.toContain(outside);
  });
});

describe("F3: the pre-validation allowance and its skip reason", () => {
  it("imports a file whose cwd comes after 1,000 cwd-free lines", async () => {
    const lines: object[] = Array.from({ length: 1_000 }, (_, i) =>
      userPrompt(`p${i}`, { ts: T(i), cwd: null }),
    );
    lines.push(userPrompt("late", { ts: T(1_001), cwd: root }));
    put(jsonl(lines));

    const { batches, counts, skips } = await runImport();
    expect(counts.skipped).toBe(0);
    expect(counts.imported).toBeGreaterThan(1_000);
    // The session started on a cwd-free line, so its started event carries no folder (lead
    // decision: session.started is unchanged); no event may carry an outside folder.
    expect(workingDirectories(batches).filter((d) => d !== "" && !d.startsWith(root))).toEqual([]);
    expect(skips).toEqual([]);
  });

  it("skips a file that shows no cwd within the allowance, with a distinct reason", async () => {
    // 20,000 lines of about 1 KiB: past 5,000 lines and past 16 MiB, so past any allowance.
    const pad = "x".repeat(1_000);
    const lines: object[] = Array.from({ length: 20_000 }, (_, i) =>
      userPrompt(`${pad}${i}`, { ts: T(i % 3_600), cwd: null }),
    );
    lines.push(userPrompt("late", { ts: T(0), cwd: root }));
    put(jsonl(lines));

    const { batches, counts, skips } = await runImport();
    expect(batches.flatMap((b) => b.events)).toEqual([]);
    expect(counts).toMatchObject({ read: 0, imported: 0, skipped: 1 });
    expect(skips).toEqual([{ reason: "no-cwd-in-allowance" }]);
  }, 60_000);

  it("records a different reason for a file outside the root", async () => {
    put(jsonl([userPrompt("a", { ts: T(0), cwd: outside })]));
    const { counts, skips } = await runImport();
    expect(counts.skipped).toBe(1);
    expect(skips).toEqual([{ reason: "outside-root" }]);
  });
});

describe("F4: counts on the abort path for an unvalidated file", () => {
  it("does not count the unyielded lines of a file that was never validated", async () => {
    // About 1 MiB of cwd-free lines, then a cwd line, so the abort lands before validation.
    const pad = "y".repeat(1_000);
    const lines: object[] = Array.from({ length: 1_000 }, (_, i) =>
      userPrompt(`${pad}${i}`, { ts: T(i), cwd: null }),
    );
    lines.push(userPrompt("late", { ts: T(1_001), cwd: root }));
    put(jsonl(lines));

    // A signal that reads as aborted from its fifth check on, so the abort lands part way
    // through the file (the importer checks it before and while reading).
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 4;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;

    const { batches, counts } = await runImport(signal);
    expect(checks).toBeGreaterThan(4);
    expect(batches.flatMap((b) => b.events)).toEqual([]);
    expect(counts).toMatchObject({ read: 0, imported: 0, malformed: 0 });
  });
});

// M8.20 review fixes (roborev 7782, security M1, L1, L3).
describe("review: unsupported-type line carries the first cwd", () => {
  it("skips a file whose first cwd, on an unsupported-type line, is outside the root", async () => {
    const odd = { type: "unsupported-kind", cwd: outside, sessionId: SESSION };
    put(`${JSON.stringify(odd)}\n${jsonl([userPrompt("second", { ts: T(1), cwd: root })])}`);

    const { batches, counts, skips } = await runImport();
    expect(batches.flatMap((b) => b.events)).toEqual([]);
    expect(counts.skipped).toBe(1);
    expect(skips).toEqual([{ reason: "outside-root" }]);
  });
});

describe("review: event ceiling before validation", () => {
  it("skips a cwd-free prefix that produces over 10,000 events, well under the line and byte limits", async () => {
    const toolLine = (n: number) => ({
      type: "assistant",
      sessionId: SESSION,
      timestamp: T(n),
      uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      message: {
        role: "assistant",
        model: "claude-test",
        stop_reason: "tool_use",
        content: Array.from({ length: 1_000 }, (_, i) => ({
          type: "tool_use",
          id: `t${n}-${i}`,
          name: "Bash",
          input: {},
        })),
      },
    });
    // 12 lines of 1,000 tool blocks: over 10,000 events with no cwd, far below 5,000 lines.
    const lines: object[] = Array.from({ length: 12 }, (_, n) => toolLine(n));
    lines.push(userPrompt("late", { ts: T(100), cwd: root }));
    put(jsonl(lines));

    const { batches, counts, skips } = await runImport();
    expect(batches.flatMap((b) => b.events)).toEqual([]);
    expect(counts).toMatchObject({ imported: 0, skipped: 1 });
    expect(skips).toEqual([{ reason: "no-cwd-in-allowance" }]);
  }, 60_000);
});

describe("review: the checked cwd is the stored cwd", () => {
  it("never imports an outside workingDirectory for a path cut at 4,096 code points", async () => {
    const crafted = `${outside}/${"a/".repeat(2_100)}${"../".repeat(2_100)}../w/app`;
    put(jsonl([userPrompt("go", { ts: T(0), cwd: crafted })]));

    const { batches } = await runImport();
    expect(workingDirectories(batches).filter((d) => d !== "" && !d.startsWith(root))).toEqual([]);
  });
});

describe("review: a relative cwd never validates", () => {
  for (const rel of [".", "sub"]) {
    it(`does not validate a file by the relative cwd ${JSON.stringify(rel)}`, async () => {
      mkdirSync(join(root, "sub"), { recursive: true });
      const before = process.cwd();
      process.chdir(root);
      try {
        put(jsonl([userPrompt("go", { ts: T(0), cwd: rel })]));
        const { batches, counts } = await runImport();
        expect(batches.flatMap((b) => b.events)).toEqual([]);
        expect(counts.skipped).toBe(1);
      } finally {
        process.chdir(before);
      }
    });
  }

  it("does not import a session whose own cwd is relative", async () => {
    const before = process.cwd();
    process.chdir(root);
    try {
      put(
        jsonl([
          userPrompt("a", { ts: T(0), cwd: root, sessionId: SESSION }),
          userPrompt("b", { ts: T(1), cwd: ".", sessionId: OTHER }),
        ]),
      );
      const { batches } = await runImport();
      expect(workingDirectories(batches).filter((d) => d !== "" && !d.startsWith(root))).toEqual(
        [],
      );
    } finally {
      process.chdir(before);
    }
  });
});
