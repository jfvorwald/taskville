import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { InputEventWire } from "@taskville/protocol";
import { shortHash } from "../../sources/git/index.ts";
import { isSha } from "../../sources/git/parse.ts";
import type { ImportBatch, ImportCounts, Importer } from "../types.ts";
import {
  GitFailure,
  IMPORT_GIT_MAX_OUTPUT_BYTES,
  IMPORT_GIT_TIMEOUT_MS,
  runImportGit,
} from "./run.ts";

// The Git importer (M8.01, imports design "Importers: Git"): walks a repository's whole history,
// read-only, and yields imported git.commit, git.merge and git.ref_moved events in topological
// order. No author or committer names or emails are read. Only validated object names reach
// git's argument list, after `--`.

/** Commits per `git log` call and per yielded batch (the contract requires fewer than 10,000). */
const BATCH_SIZE = 500;

/** One record per commit, framed by NUL (git cannot store NUL in a message); name-status lines follow. */
const LOG_FORMAT = "%x00%H%x1f%P%x1f%s";
const REF_FORMAT = [
  "%(objectname)",
  "%(objecttype)",
  "%(*objectname)",
  "%(*objecttype)",
  "%(committerdate:unix)",
  "%(*committerdate:unix)",
  "%(symref)",
  "%(refname)",
].join("%09");

interface Files {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
}

interface CommitRecord {
  sha: string;
  parents: string[];
  subject: string;
  files: Files;
}

/**
 * Unix seconds as an ISO timestamp, or undefined. Git prints a pre-1970 date (`rev-list --timestamp`,
 * `for-each-ref`) as an unsigned 64-bit number, so a value of 2^63 or more is read as negative.
 */
function unixToIso(text: string): string | undefined {
  if (!/^-?\d{1,20}$/.test(text)) return undefined;
  let seconds = BigInt(text);
  if (seconds >= 2n ** 63n) seconds -= 2n ** 64n;
  if (seconds > 999_999_999_999n || seconds < -999_999_999_999n) return undefined;
  const ms = Number(seconds) * 1000;
  return Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}

/** Accepts only requested SHAs, and only the first record for each. */
function parseLog(output: string, requested: ReadonlySet<string>): Map<string, CommitRecord> {
  const commits = new Map<string, CommitRecord>();
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const lines = record.split("\n");
    const fields = (lines[0] ?? "").split("\x1f");
    if (fields.length < 3) continue;
    const [sha = "", parentText = ""] = fields;
    const parents = parentText === "" ? [] : parentText.split(" ");
    if (!isSha(sha) || !parents.every(isSha)) continue;
    if (!requested.has(sha) || commits.has(sha)) continue;
    const files: Files = { added: 0, modified: 0, deleted: 0, renamed: 0 };
    for (const line of lines.slice(1)) {
      const status = /^([ADMTR])\d*\t/.exec(line)?.[1];
      if (status === "A") files.added++;
      else if (status === "D") files.deleted++;
      else if (status === "R") files.renamed++;
      else if (status === "M" || status === "T") files.modified++;
    }
    commits.set(sha, {
      sha,
      parents,
      subject: fields.slice(2).join("\x1f"),
      files,
    });
  }
  return commits;
}

const idPart = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);

export interface GitImporterOptions {
  batchSize?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export function createGitImporter(options: GitImporterOptions = {}): Importer {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const limits = {
    timeoutMs: options.timeoutMs ?? IMPORT_GIT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? IMPORT_GIT_MAX_OUTPUT_BYTES,
  };
  return {
    kind: "git",
    async *run(context) {
      const counts: ImportCounts = { read: 0, imported: 0, skipped: 0, malformed: 0 };
      const { signal } = context;
      const finish = (): ImportCounts => {
        context.progress({ ...counts });
        return { ...counts };
      };
      if (signal.aborted) return finish();

      const repo = await realpath(context.root);
      const sourceId = `git:${shortHash(repo)}`;
      const event = (
        sourceEventId: string,
        occurredAt: string,
        sourceSequence: number,
        type: string,
        payload: object,
      ): InputEventWire =>
        ({
          schemaVersion: 1,
          projectId: context.projectId,
          sourceId,
          sourceEventId,
          sourceSequence,
          occurredAt,
          type,
          payload,
          provenance: "imported",
        }) as InputEventWire;

      const git = (args: readonly string[]) => runImportGit(repo, args, signal, limits);
      // HEAD joins the walk only when it resolves to a commit (not unborn), for detached commits.
      const headResolves = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).then(
        () => true,
        (error: unknown) => {
          if (error instanceof GitFailure && error.exitCode === 1) return false;
          throw error;
        },
      );
      const listed = await git([
        "rev-list",
        "--timestamp",
        "--topo-order",
        "--reverse",
        "--branches",
        "--tags",
        "--remotes",
        ...(headResolves ? ["HEAD"] : []),
        "--",
      ]);
      // A batch whose log output overflows the cap is halved and retried.
      const readLog = async (batch: string[]): Promise<Map<string, CommitRecord>> => {
        try {
          const output = await git([
            "log",
            "--no-walk=unsorted",
            "--root",
            "-M",
            "--no-ext-diff",
            "--name-status",
            `--format=${LOG_FORMAT}`,
            ...batch,
            "--",
          ]);
          return parseLog(output, new Set(batch));
        } catch (error) {
          if (
            batch.length < 2 ||
            !(error instanceof GitFailure) ||
            error.message !== "git_output_too_large"
          ) {
            throw error;
          }
          const half = Math.ceil(batch.length / 2);
          const first = await readLog(batch.slice(0, half));
          for (const [sha, record] of await readLog(batch.slice(half))) first.set(sha, record);
          return first;
        }
      };
      // `rev-list --timestamp` lines are `<committer seconds> <sha>`; its dates come out in a form
      // `log` cannot print for a pre-1970 commit.
      const shas: string[] = [];
      const dates = new Map<string, string>();
      for (const line of listed.split("\n")) {
        if (line === "") continue;
        const [seconds = "", sha = ""] = line.split(" ");
        shas.push(sha);
        dates.set(sha, seconds);
      }
      let sequence = 0;

      for (let start = 0; start < shas.length; start += batchSize) {
        if (signal.aborted) return finish();
        const slice = shas.slice(start, start + batchSize);
        const valid = slice.filter(isSha);
        counts.read += slice.length;
        counts.malformed += slice.length - valid.length;
        const log = valid.length === 0 ? new Map<string, CommitRecord>() : await readLog(valid);
        const events: InputEventWire[] = [];
        for (const sha of slice) {
          const index = sequence++;
          const c = log.get(sha);
          const committedAt = unixToIso(dates.get(sha) ?? "");
          if (c === undefined || committedAt === undefined) {
            counts.malformed++;
            continue;
          }
          const merge = c.parents.length >= 2;
          events.push(
            event(`commit:${sha}`, committedAt, index, "git.commit", {
              repo,
              sha,
              parents: c.parents,
              ...(c.subject === "" ? {} : { subject: c.subject }),
              // A merge shows no diff against its first parent here, so its counts are unknown.
              ...(merge ? {} : { files: c.files }),
            }),
          );
          if (merge) {
            events.push(
              event(`merge:${sha}`, committedAt, index, "git.merge", {
                repo,
                sha,
                parents: c.parents,
              }),
            );
          }
        }
        counts.imported += events.length;
        context.progress({ ...counts });
        yield { events } satisfies ImportBatch;
      }

      if (signal.aborted) return finish();
      const refOutput = await git([
        "for-each-ref",
        `--format=${REF_FORMAT}`,
        "--",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ]);
      let events: InputEventWire[] = [];
      for (const line of refOutput.split("\n")) {
        if (line === "") continue;
        if (events.length >= batchSize) {
          if (signal.aborted) return finish();
          counts.imported += events.length;
          context.progress({ ...counts });
          yield { events } satisfies ImportBatch;
          events = [];
        }
        counts.read++;
        const f = line.split("\t");
        if (f.length !== 8) {
          counts.malformed++;
          continue;
        }
        const [objectName = "", type = "", peeledName = "", peeledType = ""] = f;
        const [date = "", peeledDate = "", symref = "", ref = ""] = f.slice(4);
        // Only local branches and tags get ref events; remote-tracking and symbolic refs are skipped.
        if (symref !== "" || !(ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/"))) {
          counts.skipped++;
          continue;
        }
        const annotated = type === "tag";
        const target = annotated ? peeledName : objectName;
        const targetType = annotated ? peeledType : type;
        if (targetType !== "commit") {
          counts.skipped++;
          continue;
        }
        const committedAt = unixToIso(annotated ? peeledDate : date);
        if (ref === "" || !isSha(target) || committedAt === undefined) {
          counts.malformed++;
          continue;
        }
        events.push(
          event(`ref:${idPart(ref)}:${target}`, committedAt, sequence++, "git.ref_moved", {
            repo,
            ref,
            to: target,
          }),
        );
      }
      counts.imported += events.length;
      context.progress({ ...counts });
      if (events.length > 0) yield { events } satisfies ImportBatch;
      return finish();
    },
  };
}

export const gitImporter: Importer = createGitImporter();
