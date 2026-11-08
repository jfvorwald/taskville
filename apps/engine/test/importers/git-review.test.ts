import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type InputEventWire, parseInputEvent } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as gitModule from "../../src/importers/git/index.ts";
import type {
  ImportBatch,
  ImportContext,
  ImportCounts,
  Importer,
} from "../../src/importers/types.ts";

// M8.01 review-fix round (issue #89, PR #467). Encodes the roborev and code review findings.
//
// Options encoded (the implementer must provide them):
//   createGitImporter({ batchSize?, maxOutputBytes?, timeoutMs? }): Importer
// exported from src/importers/git/index.ts, alongside the default `gitImporter`. Failures throw an
// Error whose `message` is exactly one of: not_a_repository, git_timeout, git_output_too_large
// (no path, no stderr text).

type Options = { batchSize?: number; maxOutputBytes?: number; timeoutMs?: number };
type Factory = (options: Options) => Importer;

function importerWith(options: Options): Importer {
  const factory = (gitModule as unknown as { createGitImporter?: Factory }).createGitImporter;
  if (typeof factory !== "function") {
    throw new Error("createGitImporter is not exported from importers/git/index.ts");
  }
  return factory(options);
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Author Name",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "Committer Name",
  GIT_COMMITTER_EMAIL: "committer@example.invalid",
};

function git(repo: string, args: string[], at?: number | string, input?: string): string {
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

function initRepo(parent: string, name = "repo"): string {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  return root;
}

function commit(repo: string, at: number, subject: string, files: Record<string, string> = {}) {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--allow-empty", "--cleanup=verbatim", "-m", subject], at);
  return git(repo, ["rev-parse", "HEAD"]);
}

interface Run {
  events: InputEventWire[];
  batches: ImportBatch[];
  counts: ImportCounts;
}

async function runWith(
  importer: Importer,
  root: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<Run> {
  const context: ImportContext = { projectId: "proj-a", root, signal, progress: () => {} };
  const generator = importer.run(context);
  const batches: ImportBatch[] = [];
  for (;;) {
    const step = await generator.next();
    if (step.done) {
      return { events: batches.flatMap((b) => b.events), batches, counts: step.value };
    }
    batches.push(step.value);
  }
}

async function runImport(root: string): Promise<Run> {
  return runWith(gitModule.gitImporter, root);
}

const ofType = (events: InputEventWire[], type: string) => events.filter((e) => e.type === type);
const payloadOf = (e: InputEventWire) => e.payload as Record<string, unknown>;
const commitFor = (events: InputEventWire[], sha: string) =>
  ofType(events, "git.commit").find((e) => payloadOf(e).sha === sha);
const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the import to throw");
}

function fastImport(repo: string, total: number, ref = "refs/heads/main", start = 1_000_000) {
  let stream = "";
  for (let i = 0; i < total; i++) {
    const msg = `commit ${i}`;
    stream += `commit ${ref}\ncommitter C <c@example.invalid> ${start + i} +0000\n`;
    stream += `data ${msg.length}\n${msg}\n`;
    stream += `M 644 inline f.txt\ndata ${String(i).length}\n${i}\n\n`;
  }
  git(repo, ["fast-import", "--quiet"], undefined, stream);
}

let dir = "";

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "taskville-git-review-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("commit and ref selection", () => {
  it("imports commits reachable only from a detached HEAD, with no ref event for HEAD", async () => {
    const root = initRepo(dir);
    const base = commit(root, 1000, "base", { "a.txt": "a\n" });
    git(root, ["checkout", "-q", "--detach"]);
    const detached = commit(root, 2000, "detached only", { "b.txt": "b\n" });
    const { events } = await runImport(root);
    expect(commitFor(events, base)).toBeDefined();
    expect(commitFor(events, detached)).toBeDefined();
    const refs = ofType(events, "git.ref_moved").map((e) => String(payloadOf(e).ref));
    expect(refs.some((r) => r.includes("HEAD"))).toBe(false);
  });

  it("imports remote-tracking commits but emits ref events only for local branches and tags", async () => {
    const root = initRepo(dir);
    const base = commit(root, 1000, "base", { "a.txt": "a\n" });
    git(root, ["checkout", "-q", "-b", "scratch"]);
    const remoteOnly = commit(root, 2000, "remote only", { "r.txt": "r\n" });
    git(root, ["update-ref", "refs/remotes/origin/main", remoteOnly]);
    git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    git(root, ["checkout", "-q", "main"]);
    git(root, ["branch", "-D", "scratch"]);
    git(root, ["tag", "v1", base]);

    const { events, counts } = await runImport(root);
    expect(commitFor(events, remoteOnly)).toBeDefined();
    const refs = ofType(events, "git.ref_moved")
      .map((e) => String(payloadOf(e).ref))
      .sort();
    expect(refs).toEqual(["refs/heads/main", "refs/tags/v1"]);
    // origin/main and origin/HEAD are read and skipped.
    expect(counts.skipped).toBe(2);
  });

  it("resolves an annotated tag to its commit", async () => {
    const root = initRepo(dir);
    const sha = commit(root, 1000, "base", { "a.txt": "a\n" });
    git(root, ["tag", "-a", "-m", "release", "v2", sha], 1500);
    const { events } = await runImport(root);
    const tag = ofType(events, "git.ref_moved")
      .map(payloadOf)
      .find((p) => p.ref === "refs/tags/v2");
    expect(tag?.to).toBe(sha);
  });

  it("skips a lightweight tag on a tree or a blob", async () => {
    const root = initRepo(dir);
    commit(root, 1000, "base", { "a.txt": "a\n" });
    git(root, ["tag", "tree-tag", git(root, ["rev-parse", "HEAD^{tree}"])]);
    git(root, ["tag", "blob-tag", git(root, ["rev-parse", "HEAD:a.txt"])]);
    const { events, counts } = await runImport(root);
    const refs = ofType(events, "git.ref_moved").map((e) => String(payloadOf(e).ref));
    expect(refs).toEqual(["refs/heads/main"]);
    expect(counts.skipped).toBe(2);
    expect(counts.malformed).toBe(0);
  });
});

describe("NUL framing", () => {
  it("keeps a subject containing U+001E and U+001F whole and cannot forge another record", async () => {
    const root = initRepo(dir);
    const forged = "a".repeat(40);
    const first = commit(root, 1000, "first", { "a.txt": "a\n" });
    const subject = `evil\x1e${forged}\x1f${first}\x1f5\x1fforged subject\x1fmore`;
    const evil = commit(root, 2000, subject, { "b.txt": "b\n" });
    const last = commit(root, 3000, "last", { "c.txt": "c\n" });

    const { events } = await runImport(root);
    expect(commitFor(events, forged)).toBeUndefined();
    const commits = ofType(events, "git.commit");
    expect(commits).toHaveLength(3);

    const evilEvent = commitFor(events, evil) as InputEventWire;
    expect(payloadOf(evilEvent)).toMatchObject({
      parents: [first],
      subject,
      files: { added: 1, modified: 0, deleted: 0, renamed: 0 },
    });
    expect(evilEvent.occurredAt).toBe(new Date(2000 * 1000).toISOString());
    const lastEvent = commitFor(events, last) as InputEventWire;
    expect(payloadOf(lastEvent)).toMatchObject({
      parents: [evil],
      files: { added: 1, modified: 0, deleted: 0, renamed: 0 },
    });
    expect(lastEvent.occurredAt).toBe(new Date(3000 * 1000).toISOString());
  });
});

describe("bounded sourceId", () => {
  it("imports a repository whose realpath is over 196 characters, with the watcher's sourceId", async () => {
    const deep = join(dir, "d".repeat(70), "e".repeat(70), "f".repeat(70));
    const root = initRepo(deep, "repo");
    const real = realpathSync(root);
    expect(real.length).toBeGreaterThan(196);
    commit(root, 1000, "base", { "a.txt": "a\n" });
    commit(root, 2000, "second", { "b.txt": "b\n" });

    const { events } = await runImport(real);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(parseInputEvent(event).ok).toBe(true);
      expect(event.sourceId).toBe(`git:${shortHash(real)}`);
      expect(event.sourceId.length).toBeLessThanOrEqual(196);
    }
  });
});

describe("large output and git failures", () => {
  it("halves a log batch that would exceed the output cap and still imports everything", async () => {
    const root = initRepo(dir);
    const shas: string[] = [];
    for (let i = 0; i < 40; i++) {
      shas.push(commit(root, 1000 + i, `${i} ${"s".repeat(200)}`, { [`f${i}.txt`]: `${i}\n` }));
    }
    const { events, counts } = await runWith(
      importerWith({ batchSize: 40, maxOutputBytes: 4000 }),
      root,
    );
    const commits = ofType(events, "git.commit");
    expect(commits.map((e) => payloadOf(e).sha)).toEqual(shas);
    const sequences = commits.map((e) => e.sourceSequence);
    expect(sequences).toEqual(shas.map((_, i) => i));
    expect(counts.malformed).toBe(0);
  });

  it("throws not_a_repository, with no path or stderr text, for a non-repository root", async () => {
    const plain = join(dir, "plain-secret-dir");
    mkdirSync(plain);
    const error = await errorOf(runImport(realpathSync(plain)));
    expect(error.message).toBe("not_a_repository");
  });

  it("maps a timeout to git_timeout", async () => {
    const root = initRepo(dir);
    commit(root, 1000, "base", { "a.txt": "a\n" });
    const error = await errorOf(runWith(importerWith({ timeoutMs: 1 }), root));
    expect(error.message).toBe("git_timeout");
  });

  it("maps an over-cap rev-list to git_output_too_large", async () => {
    const root = initRepo(dir);
    for (let i = 0; i < 10; i++) commit(root, 1000 + i, `c${i}`, { [`f${i}.txt`]: `${i}\n` });
    const error = await errorOf(runWith(importerWith({ maxOutputBytes: 100 }), root));
    expect(error.message).toBe("git_output_too_large");
  });
});

describe("coverage gaps", () => {
  it("lists a parent before its children even when a child is older (needs --topo-order)", async () => {
    const root = initRepo(dir);
    const p = commit(root, 5000, "P", { "p.txt": "p\n" });
    git(root, ["checkout", "-q", "-b", "bx"]);
    const x = commit(root, 2000, "X", { "x.txt": "x\n" });
    git(root, ["checkout", "-q", "-b", "by", p]);
    const y = commit(root, 6000, "Y", { "y.txt": "y\n" });
    git(root, ["branch", "-D", "main"]);
    const { events } = await runImport(root);
    const seq = (sha: string) => commitFor(events, sha)?.sourceSequence as number;
    expect(seq(p)).toBeLessThan(seq(x));
    expect(seq(p)).toBeLessThan(seq(y));
  });

  it("counts a deleted file", async () => {
    const root = initRepo(dir);
    commit(root, 1000, "base", { "gone.txt": "gone\n", "stay.txt": "stay\n" });
    git(root, ["rm", "-q", "gone.txt"]);
    const del = commit(root, 2000, "delete", {});
    const { events } = await runImport(root);
    expect(payloadOf(commitFor(events, del) as InputEventWire).files).toEqual({
      added: 0,
      modified: 0,
      deleted: 1,
      renamed: 0,
    });
  });

  it("gives an octopus merge git.merge with all three parents", async () => {
    const root = initRepo(dir);
    const base = commit(root, 1000, "base", { "base.txt": "b\n" });
    const tips: string[] = [];
    for (const name of ["one", "two", "three"]) {
      git(root, ["checkout", "-q", "-b", name, base]);
      tips.push(commit(root, 2000, name, { [`${name}.txt`]: `${name}\n` }));
    }
    git(root, ["checkout", "-q", "one"]);
    git(root, ["merge", "-q", "--no-ff", "-m", "octopus", "two", "three"], 3000);
    const octopus = git(root, ["rev-parse", "HEAD"]);
    const { events } = await runImport(root);
    const merge = ofType(events, "git.merge").find((e) => payloadOf(e).sha === octopus);
    expect(merge).toBeDefined();
    const parents = payloadOf(merge as InputEventWire).parents as string[];
    expect(parents).toHaveLength(3);
    expect([...parents].sort()).toEqual([...tips].sort());
  });

  it("gives an empty commit zero counts", async () => {
    const root = initRepo(dir);
    commit(root, 1000, "base", { "a.txt": "a\n" });
    const empty = commit(root, 2000, "empty");
    const { events } = await runImport(root);
    expect(payloadOf(commitFor(events, empty) as InputEventWire).files).toEqual({
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
    });
  });

  it("imports every commit once with continuous sourceSequence across the batch boundary", async () => {
    const root = initRepo(dir);
    const total = 1200;
    fastImport(root, total);
    const { events } = await runImport(realpathSync(root));
    const commits = ofType(events, "git.commit");
    expect(commits).toHaveLength(total);
    expect(new Set(commits.map((e) => payloadOf(e).sha)).size).toBe(total);
    const sequences = commits.map((e) => e.sourceSequence as number).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: total }, (_, i) => i));
  }, 60_000);

  it("yields no events when already aborted, whether it throws or returns", async () => {
    const root = initRepo(dir);
    commit(root, 1000, "base", { "a.txt": "a\n" });
    const controller = new AbortController();
    controller.abort();
    const seen: ImportBatch[] = [];
    const generator = gitModule.gitImporter.run({
      projectId: "proj-a",
      root,
      signal: controller.signal,
      progress: () => {},
    });
    try {
      for (;;) {
        const step = await generator.next();
        if (step.done) break;
        seen.push(step.value);
      }
    } catch {
      // Throwing on abort is allowed.
    }
    expect(seen.flatMap((b) => b.events)).toHaveLength(0);
  });

  it("kills the running git child when aborted mid-call", async () => {
    const root = initRepo(dir);
    commit(root, 1000, "base", { "a.txt": "a\n" });
    const bin = join(dir, "fakebin");
    mkdirSync(bin);
    const pidFile = join(dir, "fake-git.pid");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\necho $$ > "$TASKVILLE_FAKE_PID_FILE"\nexec sleep 30\n`,
    );
    chmodSync(join(bin, "git"), 0o755);

    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
    process.env.TASKVILLE_FAKE_PID_FILE = pidFile;
    try {
      const controller = new AbortController();
      const abortable = runWith(gitModule.gitImporter, root, controller.signal).then(
        () => undefined,
        () => undefined,
      );
      const deadline = Date.now() + 5000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(pid)).toBe(true);
      controller.abort();
      await abortable;
      await new Promise((r) => setTimeout(r, 300));
      const alive = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (alive) process.kill(pid, "SIGKILL");
      expect(alive).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      delete process.env.TASKVILLE_FAKE_PID_FILE;
    }
  }, 30_000);

  it("ignores refs/replace entries: imported parents are the real ones", async () => {
    const root = initRepo(dir);
    const r = commit(root, 1000, "R", { "r.txt": "r\n" });
    const a = commit(root, 2000, "A", { "a.txt": "a\n" });
    const b = commit(root, 3000, "B", { "b.txt": "b\n" });
    const fake = git(root, ["commit-tree", `${b}^{tree}`, "-p", r, "-m", "replacement"], 4000);
    git(root, ["replace", b, fake]);
    const { events } = await runImport(root);
    expect(payloadOf(commitFor(events, b) as InputEventWire).parents).toEqual([a]);
    expect(ofType(events, "git.commit")).toHaveLength(3);
  });

  it("imports commits dated before 1970 with a negative timestamp", async () => {
    const root = initRepo(dir);
    const stream = `commit refs/heads/main\ncommitter C <c@example.invalid> -86400 +0000\ndata 3\nold\nM 644 inline f.txt\ndata 2\nx\n\n`;
    git(root, ["fast-import", "--quiet", "--date-format=raw"], undefined, stream);
    const old = git(root, ["rev-parse", "main"]);
    const { events, counts } = await runImport(root);
    const event = commitFor(events, old);
    expect(event?.occurredAt).toBe("1969-12-31T00:00:00.000Z");
    expect(counts.malformed).toBe(0);
  });
});
