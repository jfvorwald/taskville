import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { EventBatchResponse } from "@taskville/protocol";
import type { Logger } from "pino";
import type { StorageReads } from "../../storage/index.ts";
import {
  type CommitRecord,
  LOG_FORMAT,
  parseLog,
  parseRefs,
  REF_FORMAT,
  type RefTip,
} from "./parse.ts";
import { type GitRunner, runGit } from "./run.ts";

// The live Git watcher (ARCHITECTURE.md 8.2, M2.09). For every configured repository root it
// reads `git for-each-ref` and `git log`, read-only, every few seconds and when `.git/refs`
// changes, and ingests git.commit, git.merge, and git.ref_moved through the ingest pipeline,
// so the events are validated, masked, deduplicated, and broadcast like any other.
//
// It never changes checkout state: no fetch, checkout, or index write (GIT_OPTIONAL_LOCKS=0).
// Ref names never reach git's argument list; only validated object names do.

/** Default time between scans. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Newest commits recorded on a repository's first scan (per engine start). */
export const DEFAULT_INITIAL_COMMIT_LIMIT = 200;
/** Most commits recorded by one later scan (a large fetch records only its newest). */
export const DEFAULT_SCAN_COMMIT_LIMIT = 1_000;
/** Most branch refs (`refs/heads`, `refs/remotes`) read per repository. */
export const DEFAULT_MAX_REFS = 1_000;
/** How long a root that is not a repository waits before it is tried again. */
export const RESOLVE_RETRY_MS = 60_000;
/** Ref changes within this window cause one scan. */
const DEBOUNCE_MS = 250;

export interface GitWatcherOptions {
  /**
   * The project registry (every project's roots are watched, including ones added later) and
   * its event log, from which the last recorded branch tips are restored after a restart.
   */
  storage: Pick<StorageReads, "projects" | "events">;
  /** The ingest pipeline's `ingest`. */
  ingest: (events: readonly unknown[]) => EventBatchResponse;
  now?: () => Date;
  pollIntervalMs?: number;
  initialCommitLimit?: number;
  scanCommitLimit?: number;
  maxRefs?: number;
  /** Also scan when files under `.git/refs` or `packed-refs` change (default true). */
  watchFiles?: boolean;
  git?: GitRunner;
  logger?: Logger;
}

interface Repo {
  projectId: string;
  /** The repository's top level, which is the configured root itself. */
  path: string;
  commonDir: string;
  sourceId: string;
  /**
   * Branch tips at the last scan, keyed by `refKey` of the raw ref name; undefined until the
   * first scan restores or reads them.
   */
  tips: Map<string, string> | undefined;
  /** The scan in progress or last finished; scans of one repository never overlap. */
  running: Promise<void>;
  /** A scan queued behind `running` and not yet started. */
  pending: Promise<void> | undefined;
  fileWatchers: FSWatcher[];
  debounce: NodeJS.Timeout | undefined;
}

type RootState = { repo: { path: string; commonDir: string } } | { failedAt: number };

export class GitWatcher {
  readonly #options: GitWatcherOptions;
  readonly #git: GitRunner;
  readonly #now: () => Date;
  /** Keyed by `<projectId>\0<root>`. */
  readonly #roots = new Map<string, RootState>();
  /** Keyed by `<projectId>\0<repository path>`. */
  readonly #repos = new Map<string, Repo>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: GitWatcherOptions) {
    this.#options = options;
    this.#git = options.git ?? runGit;
    this.#now = options.now ?? (() => new Date());
  }

  /** Scans now, then every poll interval, until `stop`. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    void this.scanAll();
    this.#timer = setInterval(
      () => void this.scanAll(),
      this.#options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
    this.#timer.unref();
  }

  /** Stops polling and file watching, and waits for scans in progress. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const repo of this.#repos.values()) {
      if (repo.debounce !== undefined) clearTimeout(repo.debounce);
      for (const w of repo.fileWatchers) w.close();
      repo.fileWatchers = [];
    }
    await Promise.all([...this.#repos.values()].map((repo) => repo.running));
  }

  /** Picks up new roots, then scans every repository once. Never throws. */
  async scanAll(): Promise<void> {
    try {
      await this.#refreshRepos();
      await Promise.all([...this.#repos.values()].map((repo) => this.#schedule(repo)));
    } catch (error) {
      this.#warn(error, "git scan failed");
    }
  }

  async #refreshRepos(): Promise<void> {
    for (const project of this.#options.storage.projects()) {
      for (const root of project.roots) {
        const key = `${project.id}\0${root}`;
        const state = this.#roots.get(key);
        if (state !== undefined && "repo" in state) continue;
        if (state !== undefined && this.#now().getTime() - state.failedAt < RESOLVE_RETRY_MS) {
          continue;
        }
        const repo = await this.#resolve(root);
        if (repo === undefined) {
          this.#roots.set(key, { failedAt: this.#now().getTime() });
          continue;
        }
        this.#roots.set(key, { repo });
        this.#addRepo(project.id, repo);
      }
    }
  }

  /**
   * The repository whose top level is `root`. A root inside a larger repository is not
   * watched: the repository would not be one the user configured (a home directory under
   * version control, for example).
   */
  async #resolve(root: string): Promise<{ path: string; commonDir: string } | undefined> {
    try {
      const out = await this.#git(root, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ]);
      const [top, commonDir] = out.split("\n");
      if (!top || !commonDir) return undefined;
      const [realTop, realRoot] = await Promise.all([realpath(top), realpath(root)]);
      if (realTop !== realRoot) {
        this.#options.logger?.info("git root is inside a larger repository; not watched");
        return undefined;
      }
      return { path: realTop, commonDir };
    } catch {
      return undefined;
    }
  }

  #addRepo(projectId: string, found: { path: string; commonDir: string }): void {
    const key = `${projectId}\0${found.path}`;
    if (this.#repos.has(key) || this.#stopped) return;
    const repo: Repo = {
      projectId,
      path: found.path,
      commonDir: found.commonDir,
      sourceId: `git:${shortHash(found.path)}`,
      tips: undefined,
      running: Promise.resolve(),
      pending: undefined,
      fileWatchers: [],
      debounce: undefined,
    };
    this.#repos.set(key, repo);
    if (this.#options.watchFiles !== false) this.#watchFiles(repo);
  }

  /** Scans soon after a change under `refs/` or to `packed-refs`. Polling covers any miss. */
  #watchFiles(repo: Repo): void {
    const trigger = () => {
      if (this.#stopped) return;
      if (repo.debounce !== undefined) clearTimeout(repo.debounce);
      repo.debounce = setTimeout(() => {
        repo.debounce = undefined;
        void this.#schedule(repo);
      }, DEBOUNCE_MS);
      repo.debounce.unref();
    };
    const add = (
      path: string,
      options: { recursive: boolean },
      filter?: (name: string) => boolean,
    ) => {
      try {
        const w = watch(path, { recursive: options.recursive, persistent: false }, (_e, name) => {
          if (filter === undefined || (typeof name === "string" && filter(name))) trigger();
        });
        w.on("error", () => w.close());
        repo.fileWatchers.push(w);
      } catch {
        // Not supported here, or the path is gone: polling still covers it.
      }
    };
    add(join(repo.commonDir, "refs"), { recursive: true });
    add(repo.commonDir, { recursive: false }, (name) => name === "packed-refs");
  }

  /** Queues a scan behind the running one; a scan already queued is shared. */
  #schedule(repo: Repo): Promise<void> {
    if (repo.pending !== undefined) return repo.pending;
    const next = repo.running.then(async () => {
      repo.pending = undefined;
      if (this.#stopped) return;
      try {
        await this.#scan(repo);
      } catch (error) {
        this.#warn(error, "git scan of a repository failed");
      }
    });
    repo.pending = next;
    repo.running = next;
    return next;
  }

  async #scan(repo: Repo): Promise<void> {
    const maxRefs = this.#options.maxRefs ?? DEFAULT_MAX_REFS;
    const refOutput = await this.#git(repo.path, [
      "for-each-ref",
      `--format=${REF_FORMAT}`,
      `--count=${maxRefs}`,
      "refs/heads",
      "refs/remotes",
    ]);
    const tips = parseRefs(refOutput, maxRefs);
    // Every ref event is dated when it was observed: a scan cannot know when a ref moved.
    const now = this.#now().toISOString();
    const previous = repo.tips ?? this.#recordedTips(repo);

    let moves: Array<{ tip: RefTip; from?: string }>;
    let commits: CommitRecord[];
    if (previous.size === 0) {
      // Nothing recorded for this repository: where every branch points now (first observations,
      // with no `from`), and the newest commits.
      moves = tips.map((tip) => ({ tip }));
      commits = await this.#gitLog(
        repo,
        unique(tips.map((t) => t.sha)),
        [],
        this.#options.initialCommitLimit ?? DEFAULT_INITIAL_COMMIT_LIMIT,
      );
    } else {
      const changed = tips.filter((tip) => previous.get(refKey(tip.ref)) !== tip.sha);
      if (changed.length === 0) {
        repo.tips = new Map(tips.map((t) => [refKey(t.ref), t.sha]));
        return;
      }
      moves = changed.map((tip) => {
        const from = previous.get(refKey(tip.ref));
        return from === undefined ? { tip } : { tip, from };
      });
      commits = await this.#gitLog(
        repo,
        unique(changed.map((t) => t.sha)),
        unique([...previous.values()]),
        this.#options.scanCommitLimit ?? DEFAULT_SCAN_COMMIT_LIMIT,
      );
    }

    const events = [
      ...commits.reverse().flatMap((c) => this.#commitEvents(repo, c)),
      // The observation time keeps a repeated transition (A to B, back, and to B again) distinct.
      ...moves.map(({ tip, from }) =>
        this.#event(
          repo,
          `ref:${refKey(tip.ref)}:${from ?? "none"}:${tip.sha}:${Date.parse(now)}`,
          now,
          "git.ref_moved",
          {
            repo: repo.path,
            ref: tip.ref,
            ...(from === undefined ? {} : { from }),
            to: tip.sha,
          },
        ),
      ),
    ];
    if (this.#stopped) return;
    if (events.length > 0) {
      const response = this.#options.ingest(events);
      const rejected = response.results.filter((r) => r.status === "rejected").length;
      if (rejected > 0) this.#options.logger?.warn({ rejected }, "git events rejected at ingest");
    }
    repo.tips = new Map(tips.map((t) => [refKey(t.ref), t.sha]));
  }

  /**
   * Branch tips as last recorded in the project's log for this repository, so a restart reports
   * only what changed while the engine was down. Read from each move's sourceEventId, which is
   * stored as written: the payload's ref name may have been masked at ingest, the key was not.
   */
  #recordedTips(repo: Repo): Map<string, string> {
    const tips = new Map<string, string>();
    for (const event of this.#options.storage.events(repo.projectId)) {
      if (event.type !== "git.ref_moved" || event.sourceId !== repo.sourceId) continue;
      const match = MOVE_ID.exec(event.sourceEventId);
      if (match?.[1] !== undefined && match[2] !== undefined) tips.set(match[1], match[2]);
    }
    return tips;
  }

  /**
   * Commits reachable from `include` and not from `exclude`, newest first, at most `limit`. An
   * excluded commit that no longer exists (history rewritten and collected) is skipped.
   */
  async #gitLog(
    repo: Repo,
    include: string[],
    exclude: string[],
    limit: number,
  ): Promise<CommitRecord[]> {
    if (include.length === 0) return [];
    const output = await this.#git(repo.path, [
      "log",
      "-z",
      `--format=${LOG_FORMAT}`,
      `--max-count=${limit}`,
      "--ignore-missing",
      "--end-of-options",
      ...include,
      ...exclude.map((sha) => `^${sha}`),
      "--",
    ]);
    return parseLog(output);
  }

  #commitEvents(repo: Repo, c: CommitRecord): unknown[] {
    const commit = this.#event(repo, `commit:${c.sha}`, c.committedAt, "git.commit", {
      repo: repo.path,
      sha: c.sha,
      parents: c.parents,
      ...(c.subject === "" ? {} : { subject: c.subject }),
    });
    if (c.parents.length < 2) return [commit];
    return [
      commit,
      this.#event(repo, `merge:${c.sha}`, c.committedAt, "git.merge", {
        repo: repo.path,
        sha: c.sha,
        parents: c.parents,
      }),
    ];
  }

  #event(repo: Repo, sourceEventId: string, occurredAt: string, type: string, payload: object) {
    return {
      schemaVersion: 1,
      projectId: repo.projectId,
      sourceId: repo.sourceId,
      sourceEventId,
      occurredAt,
      type,
      payload,
      provenance: "live",
    };
  }

  #warn(error: unknown, message: string): void {
    // Name only: a git error message can carry repository paths and output.
    this.#options.logger?.warn({ errName: (error as Error)?.name }, message);
  }
}

const unique = (values: string[]): string[] => [...new Set(values)];

/** A ref move's sourceEventId: `ref:<refKey>:<from or none>:<to>:<observed at, ms>`. */
const MOVE_ID =
  /^ref:([0-9a-f]{16}):(?:none|[0-9a-f]{40}|[0-9a-f]{64}):([0-9a-f]{40}|[0-9a-f]{64}):\d+$/;

/** Identifies a ref by its raw name, which ingest never masks inside an ID. */
const refKey = (ref: string): string => shortHash(ref);

/** 16 hex characters of SHA-256: a bounded, stable ID part for a path or a ref name. */
const shortHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);
