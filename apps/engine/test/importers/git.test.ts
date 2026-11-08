import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InputEventWire, parseInputEvent } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitImporter } from "../../src/importers/git/index.ts";
import type { ImportBatch, ImportContext, ImportCounts } from "../../src/importers/types.ts";

// M8.01 (issue #89, imports design "Importers: Git"): a read-only Git importer that turns a
// repository's whole history into imported git.commit, git.merge and git.ref_moved events.
// These tests drive real git against a throwaway repository.

const AUTHOR_EMAIL = "author-secret@example.invalid";
const COMMITTER_EMAIL = "committer-secret@example.invalid";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Author Name",
  GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
  GIT_COMMITTER_NAME: "Committer Name",
  GIT_COMMITTER_EMAIL: COMMITTER_EMAIL,
};

function git(repo: string, args: string[], at?: number, input?: string): string {
  const env = { ...GIT_ENV } as Record<string, string | undefined>;
  if (at !== undefined) {
    env.GIT_AUTHOR_DATE = `@${at} +0000`;
    env.GIT_COMMITTER_DATE = `@${at} +0000`;
  }
  return execFileSync("git", args, {
    cwd: repo,
    env,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  }).trim();
}

function commit(repo: string, at: number, subject: string, files: Record<string, string> = {}) {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", subject], at);
  return git(repo, ["rev-parse", "HEAD"]);
}

const LONG = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");

interface Fixture {
  root: string;
  shas: Record<string, string>;
  /** Committer unix times by label. */
  times: Record<string, number>;
}

/**
 * Topology (label @ committer time):
 *   root@1000 - a@2000 - b@3000 (main) ----- merge@9000
 *                  \- c@5000 - d@4000 (feature; d is a child committed BEFORE its parent c)
 *   e@6000 and f@6000 sit on side branches off root (same timestamp)
 */
function buildFixture(dir: string): Fixture {
  const root = join(dir, "repo");
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  const shas: Record<string, string> = {};
  const times: Record<string, number> = {};
  const add = (label: string, at: number, sha: string) => {
    shas[label] = sha;
    times[label] = at;
  };

  add("root", 1000, commit(root, 1000, "root commit", { "keep.txt": "keep\n", "old.txt": LONG }));
  add(
    "a",
    2000,
    commit(root, 2000, "a: add, modify, delete, rename", {
      "new.txt": "new\n",
      "keep.txt": "keep\nchanged\n",
    }),
  );
  git(root, ["rm", "-q", "old.txt"]);
  writeFileSync(join(root, "renamed.txt"), LONG);
  // delete + add of identical content is detected as a rename by git
  add("b", 3000, commit(root, 3000, "b: pure rename", {}));

  git(root, ["checkout", "-q", "-b", "feature", shas.a as string]);
  add("c", 5000, commit(root, 5000, "c: feature work", { "feature.txt": "f\n" }));
  add("d", 4000, commit(root, 4000, "d: child older than parent", { "feature.txt": "f2\n" }));

  git(root, ["checkout", "-q", "-b", "side-e", shas.root as string]);
  add("e", 6000, commit(root, 6000, "e: same time one", { "e.txt": "e\n" }));
  git(root, ["checkout", "-q", "-b", "side-f", shas.root as string]);
  add("f", 6000, commit(root, 6000, "f: same time two", { "f.txt": "f\n" }));

  git(root, ["checkout", "-q", "main"]);
  git(root, ["merge", "-q", "--no-ff", "-m", "merge feature", "feature"], 9000);
  add("merge", 9000, git(root, ["rev-parse", "HEAD"]));

  git(root, ["tag", "v1", shas.root as string]);
  return { root: realpathSync(root), shas, times };
}

interface Run {
  events: InputEventWire[];
  batches: ImportBatch[];
  counts: ImportCounts;
  progress: ImportCounts[];
}

async function runImport(
  root: string,
  options: { signal?: AbortSignal; onBatch?: () => void } = {},
): Promise<Run> {
  const progress: ImportCounts[] = [];
  const context: ImportContext = {
    projectId: "proj-a",
    root,
    signal: options.signal ?? new AbortController().signal,
    progress: (counts) => progress.push({ ...counts }),
  };
  const generator = gitImporter.run(context);
  const batches: ImportBatch[] = [];
  for (;;) {
    const step = await generator.next();
    if (step.done) {
      return { events: batches.flatMap((b) => b.events), batches, counts: step.value, progress };
    }
    batches.push(step.value);
    options.onBatch?.();
  }
}

const ofType = (events: InputEventWire[], type: string) => events.filter((e) => e.type === type);
const payloadOf = (e: InputEventWire) => e.payload as Record<string, unknown>;

let dir = "";
let fixture: Fixture;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "taskville-git-import-")));
  fixture = buildFixture(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("gitImporter events", () => {
  it("is the git importer", () => {
    expect(gitImporter.kind).toBe("git");
  });

  it("yields a valid imported git.commit for every commit, with repo, parents, subject and file counts", async () => {
    const { events } = await runImport(fixture.root);
    const commits = ofType(events, "git.commit");
    const shas = Object.values(fixture.shas);
    expect(commits.map((e) => payloadOf(e).sha).sort()).toEqual([...shas].sort());

    for (const event of events) {
      expect(parseInputEvent(event).ok).toBe(true);
      expect(event.provenance).toBe("imported");
      expect(event.projectId).toBe("proj-a");
      expect(event.sourceId).toBe(
        `git:${createHash("sha256").update(fixture.root).digest("hex").slice(0, 16)}`,
      );
    }

    const byLabel = (label: string) =>
      commits.find((e) => payloadOf(e).sha === fixture.shas[label]) as InputEventWire;
    const rootPayload = payloadOf(byLabel("root"));
    expect(rootPayload).toMatchObject({
      repo: fixture.root,
      parents: [],
      subject: "root commit",
      files: { added: 2, modified: 0, deleted: 0, renamed: 0 },
    });
    expect(payloadOf(byLabel("a"))).toMatchObject({
      parents: [fixture.shas.root],
      subject: "a: add, modify, delete, rename",
      files: { added: 1, modified: 1, deleted: 0, renamed: 0 },
    });
    expect(payloadOf(byLabel("b"))).toMatchObject({
      files: { added: 0, modified: 0, deleted: 0, renamed: 1 },
    });
  });

  it("emits git.merge as well for merge commits only", async () => {
    const { events } = await runImport(fixture.root);
    const merges = ofType(events, "git.merge");
    expect(merges).toHaveLength(1);
    expect(payloadOf(merges[0] as InputEventWire)).toMatchObject({
      repo: fixture.root,
      sha: fixture.shas.merge,
      parents: [fixture.shas.b, fixture.shas.d],
    });
    const mergeCommit = ofType(events, "git.commit").find(
      (e) => payloadOf(e).sha === fixture.shas.merge,
    );
    expect(mergeCommit).toBeDefined();
  });

  it("emits git.ref_moved with `to` for every branch and tag", async () => {
    const { events } = await runImport(fixture.root);
    const moves = ofType(events, "git.ref_moved").map((e) => payloadOf(e));
    const to = (suffix: string) =>
      moves.find((m) => String(m.ref).endsWith(suffix) && m.repo === fixture.root)?.to;
    expect(to("main")).toBe(fixture.shas.merge);
    expect(to("feature")).toBe(fixture.shas.d);
    expect(to("side-e")).toBe(fixture.shas.e);
    expect(to("side-f")).toBe(fixture.shas.f);
    expect(to("v1")).toBe(fixture.shas.root);
    expect(moves).toHaveLength(5);
  });

  it("uses the committer date as occurredAt", async () => {
    const { events } = await runImport(fixture.root);
    for (const event of ofType(events, "git.commit")) {
      const label = Object.keys(fixture.shas).find((l) => fixture.shas[l] === payloadOf(event).sha);
      const expected = new Date((fixture.times[label as string] as number) * 1000).toISOString();
      expect(event.occurredAt).toBe(expected);
    }
  });

  it("sets sourceSequence to the topological index, parents before children, despite clocks", async () => {
    const { events } = await runImport(fixture.root);
    const commits = ofType(events, "git.commit");
    const seq = new Map<string, number>();
    for (const event of commits) {
      expect(Number.isInteger(event.sourceSequence)).toBe(true);
      seq.set(String(payloadOf(event).sha), event.sourceSequence as number);
    }
    expect(new Set(seq.values()).size).toBe(commits.length);
    for (const event of commits) {
      for (const parent of payloadOf(event).parents as string[]) {
        expect(seq.get(parent) as number).toBeLessThan(
          seq.get(String(payloadOf(event).sha)) as number,
        );
      }
    }
    // The conflicting-clock case: d is older than its parent c but still comes after it.
    expect(seq.get(fixture.shas.c as string) as number).toBeLessThan(
      seq.get(fixture.shas.d as string) as number,
    );
  });

  it("has stable, distinct sourceEventIds across two runs", async () => {
    const first = await runImport(fixture.root);
    const second = await runImport(fixture.root);
    const ids = (run: Run) => run.events.map((e) => e.sourceEventId);
    expect(new Set(ids(first)).size).toBe(first.events.length);
    expect([...ids(second)].sort()).toEqual([...ids(first)].sort());
  });

  it("never includes author or committer emails in any event", async () => {
    const { events, batches } = await runImport(fixture.root);
    const text = JSON.stringify(batches);
    expect(events.length).toBeGreaterThan(0);
    expect(text).not.toContain(AUTHOR_EMAIL);
    expect(text).not.toContain(COMMITTER_EMAIL);
    expect(text).not.toContain("example.invalid");
  });
});

describe("gitImporter counts and progress", () => {
  it("reports read, imported, skipped and malformed, and calls progress", async () => {
    const { events, counts, progress } = await runImport(fixture.root);
    const commitCount = Object.keys(fixture.shas).length;
    expect(counts.imported).toBe(events.length);
    expect(counts.read).toBe(commitCount + 5);
    expect(counts.skipped).toBe(0);
    expect(counts.malformed).toBe(0);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toEqual(counts);
  });
});

describe("gitImporter is read-only", () => {
  function snapshot(root: string) {
    const files: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(`${full}:${statSync(full).mtimeMs}:${statSync(full).size}`);
      }
    };
    walk(join(root, ".git"));
    return {
      refs: git(root, ["for-each-ref"]),
      status: git(root, ["status", "--porcelain"]),
      tree: readdirSync(root).sort(),
      gitFiles: files.sort(),
    };
  }

  it("leaves refs, index, working tree and .git untouched", async () => {
    writeFileSync(join(fixture.root, "untracked.txt"), "scratch\n");
    git(fixture.root, ["status", "--porcelain"]);
    const before = snapshot(fixture.root);
    await runImport(fixture.root);
    expect(snapshot(fixture.root)).toEqual(before);
  });
});

describe("gitImporter abort", () => {
  it("yields nothing and finishes at once when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const outcome = await runImport(fixture.root, { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    if (!(outcome instanceof Error)) expect((outcome as Run).events).toHaveLength(0);
  });

  it("stops promptly mid-run on a large history", async () => {
    const big = join(dir, "big");
    mkdirSync(big);
    git(big, ["init", "-q", "-b", "main"]);
    const total = 10_000;
    let stream = "";
    for (let i = 0; i < total; i++) {
      const msg = `commit ${i}`;
      stream += `commit refs/heads/main\ncommitter C <c@example.invalid> ${1_000_000 + i} +0000\n`;
      stream += `data ${msg.length}\n${msg}\n`;
      stream += `M 644 inline f.txt\ndata ${String(i).length}\n${i}\n\n`;
    }
    git(big, ["fast-import", "--quiet"], undefined, stream);

    const controller = new AbortController();
    const started = { at: 0 };
    let seen = 0;
    const outcome = await runImport(realpathSync(big), {
      signal: controller.signal,
      onBatch: () => {
        if (started.at === 0) {
          started.at = Date.now();
          controller.abort();
        }
      },
    })
      .then((run) => {
        seen = run.events.length;
        return undefined;
      })
      .catch((error: unknown) => error);
    expect(started.at).toBeGreaterThan(0);
    expect(Date.now() - started.at).toBeLessThan(2000);
    if (outcome === undefined) expect(seen).toBeLessThan(total);
  }, 60_000);
});
