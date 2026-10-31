import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IngestPipeline } from "../../../src/ingest/index.ts";
import { createProject } from "../../../src/projects/index.ts";
import { GitWatcher, type GitWatcherOptions } from "../../../src/sources/git/index.ts";
import { ensureUnsortedProject, openStorage, type Storage } from "../../../src/storage/index.ts";

// M2.09 (ARCHITECTURE.md 8.2): read-only polling of each configured repository root, emitting
// git.commit, git.ref_moved, and git.merge through the ingest pipeline. These tests drive real
// git against throwaway repositories.

const T0 = "2026-10-31T12:00:00.000Z";
const fixedNow = () => new Date(Date.parse(T0));

// Isolated from the developer's own git configuration, with fixed identities and dates.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

let clock = 1_790_000_000;
function git(repo: string, ...args: string[]): string {
  clock += 60;
  const date = `@${clock} +0000`;
  return execFileSync("git", args, {
    cwd: repo,
    env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: "utf8",
  }).trim();
}

function commit(repo: string, file: string, subject: string): string {
  writeFileSync(join(repo, file), `${subject}\n`);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", subject);
  return git(repo, "rev-parse", "HEAD");
}

const committedAt = (repo: string, sha: string) =>
  new Date(Number(git(repo, "show", "-s", "--format=%ct", sha)) * 1000).toISOString();

let dir = "";
let storage: Storage;
let pipeline: IngestPipeline;
let watchers: GitWatcher[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "taskville-git-")));
  storage = openStorage(join(dir, "taskville.db"));
  ensureUnsortedProject(storage, { now: fixedNow });
  pipeline = new IngestPipeline({ storage, now: fixedNow });
  watchers = [];
});

afterEach(async () => {
  for (const w of watchers) await w.stop();
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function newRepo(name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  return repo;
}

function addProject(id: string, roots: string[]): void {
  createProject(storage, { id, name: id, roots }, { now: fixedNow });
}

function watcher(options: Partial<GitWatcherOptions> = {}): GitWatcher {
  const w = new GitWatcher({
    storage,
    ingest: (events) => pipeline.ingest(events),
    watchFiles: false,
    ...options,
  });
  watchers.push(w);
  return w;
}

const gitEvents = (projectId: string): StoredEnvelope[] =>
  [...storage.events(projectId)].filter((e) => e.type.startsWith("git."));

const ofType = <T extends StoredEnvelope["type"]>(events: StoredEnvelope[], type: T) =>
  events.filter((e): e is Extract<StoredEnvelope, { type: T }> => e.type === type);

/** A repo with a feature branch merged into main with a merge commit. */
function branchAndMerge(repo: string) {
  const c1 = commit(repo, "a.txt", "first");
  git(repo, "checkout", "-q", "-b", "feature");
  const c2 = commit(repo, "b.txt", "feature work");
  git(repo, "checkout", "-q", "main");
  const c3 = commit(repo, "c.txt", "main work");
  git(repo, "merge", "-q", "--no-ff", "-m", "Merge feature", "feature");
  const m = git(repo, "rev-parse", "HEAD");
  return { c1, c2, c3, m };
}

describe("first scan of a repository with a branch and a merge", () => {
  it("records every commit, the merge, and where each branch points", async () => {
    const repo = newRepo("repo");
    const { c1, c2, c3, m } = branchAndMerge(repo);
    addProject("p", [repo]);

    await watcher().scanAll();

    const events = gitEvents("p");
    const commits = ofType(events, "git.commit");
    expect(commits.map((e) => e.payload.sha).sort()).toEqual([c1, c2, c3, m].sort());
    for (const e of commits) {
      expect(e.payload.repo).toBe(repo);
      expect(e.occurredAt).toBe(committedAt(repo, e.payload.sha));
      expect(e.sourceId).toMatch(/^git:/);
      expect(e.provenance).toBe("live");
    }
    const bySha = new Map(commits.map((e) => [e.payload.sha, e.payload]));
    expect(bySha.get(c1)).toMatchObject({ parents: [], subject: "first" });
    expect(bySha.get(c2)).toMatchObject({ parents: [c1], subject: "feature work" });
    expect(bySha.get(m)).toMatchObject({ parents: [c3, c2], subject: "Merge feature" });

    expect(ofType(events, "git.merge").map((e) => e.payload)).toEqual([
      { repo, sha: m, parents: [c3, c2] },
    ]);

    const refs = ofType(events, "git.ref_moved").map((e) => e.payload);
    expect(refs).toEqual(
      expect.arrayContaining([
        { repo, ref: "refs/heads/main", to: m },
        { repo, ref: "refs/heads/feature", to: c2 },
      ]),
    );
    expect(refs).toHaveLength(2);
  });

  it("orders commits oldest first, before the ref moves", async () => {
    const repo = newRepo("repo");
    const { c1, m } = branchAndMerge(repo);
    addProject("p", [repo]);
    await watcher().scanAll();
    const events = gitEvents("p");
    const commitShas = ofType(events, "git.commit").map((e) => e.payload.sha);
    expect(commitShas[0]).toBe(c1);
    expect(commitShas.at(-1)).toBe(m);
    const lastCommit = events.findLastIndex((e) => e.type === "git.commit");
    const firstRef = events.findIndex((e) => e.type === "git.ref_moved");
    expect(firstRef).toBeGreaterThan(lastCommit);
  });

  it("bounds the first scan to the newest commits", async () => {
    const repo = newRepo("repo");
    const shas = [1, 2, 3, 4, 5].map((i) => commit(repo, "f.txt", `commit ${i}`));
    addProject("p", [repo]);
    await watcher({ initialCommitLimit: 3 }).scanAll();
    const seen = ofType(gitEvents("p"), "git.commit").map((e) => e.payload.sha);
    expect(seen).toEqual(shas.slice(2));
  });
});

describe("later scans", () => {
  it("records a new commit and the branch move from its old to its new tip", async () => {
    const repo = newRepo("repo");
    const { m } = branchAndMerge(repo);
    addProject("p", [repo]);
    const w = watcher();
    await w.scanAll();
    const before = gitEvents("p").length;

    const c4 = commit(repo, "d.txt", "after the merge");
    await w.scanAll();

    const added = gitEvents("p").slice(before);
    expect(added.map((e) => e.type)).toEqual(["git.commit", "git.ref_moved"]);
    expect(added[0]?.payload).toEqual({ repo, sha: c4, parents: [m], subject: "after the merge" });
    expect(added[1]?.payload).toEqual({ repo, ref: "refs/heads/main", from: m, to: c4 });
  });

  it("records a new branch, and nothing when nothing changed", async () => {
    const repo = newRepo("repo");
    const c1 = commit(repo, "a.txt", "first");
    addProject("p", [repo]);
    const w = watcher();
    await w.scanAll();
    const before = gitEvents("p").length;
    await w.scanAll();
    expect(gitEvents("p").length).toBe(before);

    git(repo, "branch", "topic");
    await w.scanAll();
    expect(
      gitEvents("p")
        .slice(before)
        .map((e) => e.payload),
    ).toEqual([{ repo, ref: "refs/heads/topic", to: c1 }]);
  });

  it("records a branch that moves back to a commit it pointed at before", async () => {
    const repo = newRepo("repo");
    const c1 = commit(repo, "a.txt", "first");
    addProject("p", [repo]);
    const w = watcher();
    await w.scanAll();
    const c2 = commit(repo, "b.txt", "second");
    await w.scanAll();
    git(repo, "reset", "-q", "--hard", c1);
    await w.scanAll();
    const moves = ofType(gitEvents("p"), "git.ref_moved").map((e) => e.payload);
    expect(moves.slice(-2)).toEqual([
      { repo, ref: "refs/heads/main", from: c1, to: c2 },
      { repo, ref: "refs/heads/main", from: c2, to: c1 },
    ]);
  });
});

describe("restarts", () => {
  it("a new watcher over the same log adds nothing for unchanged history", async () => {
    const repo = newRepo("repo");
    branchAndMerge(repo);
    addProject("p", [repo]);
    await watcher().scanAll();
    const head = storage.head("p");

    await watcher().scanAll();
    expect(storage.head("p")).toBe(head);
  });
});

describe("read-only", () => {
  it("never changes the checkout, the index, or the refs", async () => {
    const repo = newRepo("repo");
    branchAndMerge(repo);
    writeFileSync(join(repo, "a.txt"), "edited, not staged\n");
    addProject("p", [repo]);
    const index = join(repo, ".git", "index");
    const snapshot = () => ({
      head: readFileSync(join(repo, ".git", "HEAD"), "utf8"),
      refs: git(repo, "for-each-ref"),
      worktree: readFileSync(join(repo, "a.txt"), "utf8"),
      index: readFileSync(index).toString("base64"),
      indexMtime: statSync(index).mtimeMs,
    });
    const before = snapshot();
    const w = watcher();
    await w.scanAll();
    await w.scanAll();
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
  });

  it("never reads a ref name as an option", async () => {
    const repo = newRepo("repo");
    const c1 = commit(repo, "a.txt", "first");
    git(repo, "update-ref", "refs/heads/--output=pwned", c1);
    addProject("p", [repo]);
    await watcher().scanAll();
    expect(existsSync(join(repo, "pwned"))).toBe(false);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    const refs = ofType(gitEvents("p"), "git.ref_moved").map((e) => e.payload.ref);
    expect(refs).toContain("refs/heads/--output=pwned");
  });
});

describe("roots and failures", () => {
  it("ignores a root that is not a git repository", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    addProject("p", [plain]);
    await expect(watcher().scanAll()).resolves.toBeUndefined();
    expect(gitEvents("p")).toEqual([]);
  });

  it("watches every project's roots and keeps each project's events apart", async () => {
    const a = newRepo("a");
    const b = newRepo("b");
    const ca = commit(a, "a.txt", "in a");
    const cb = commit(b, "b.txt", "in b");
    addProject("pa", [a]);
    addProject("pb", [b]);
    await watcher().scanAll();
    expect(ofType(gitEvents("pa"), "git.commit").map((e) => e.payload.sha)).toEqual([ca]);
    expect(ofType(gitEvents("pb"), "git.commit").map((e) => e.payload.sha)).toEqual([cb]);
  });

  it("picks up a project added after the watcher started", async () => {
    const w = watcher();
    await w.scanAll();
    const repo = newRepo("late");
    const c1 = commit(repo, "a.txt", "first");
    addProject("late", [repo]);
    await w.scanAll();
    expect(ofType(gitEvents("late"), "git.commit").map((e) => e.payload.sha)).toEqual([c1]);
  });

  it("an empty repository yields no events and no error", async () => {
    const repo = newRepo("empty");
    addProject("p", [repo]);
    await expect(watcher().scanAll()).resolves.toBeUndefined();
    expect(gitEvents("p")).toEqual([]);
  });

  it("masks a secret in a commit subject through the ingest pipeline", async () => {
    const repo = newRepo("repo");
    const token = ["gh", "p_", "Zq8".repeat(12)].join("");
    commit(repo, "a.txt", `rotate ${token}`);
    addProject("p", [repo]);
    await watcher().scanAll();
    const [c] = ofType(gitEvents("p"), "git.commit");
    expect(c?.payload.subject).not.toContain(token);
    expect(c?.payload.subject).toContain("[REDACTED:");
  });
});
