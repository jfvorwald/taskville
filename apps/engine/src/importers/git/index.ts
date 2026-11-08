import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { InputEventWire } from "@taskville/protocol";
import { isSha, unixToIso } from "../../sources/git/parse.ts";
import type { ImportBatch, ImportCounts, Importer } from "../types.ts";
import { runImportGit } from "./run.ts";

// The Git importer (M8.01, imports design "Importers: Git"): walks a repository's whole history,
// read-only, and yields imported git.commit, git.merge and git.ref_moved events in topological
// order. No author or committer names or emails are read. Only validated object names reach
// git's argument list, after `--`.

/** Commits per `git log` call and per yielded batch (the contract requires fewer than 10,000). */
const BATCH_SIZE = 500;

/** One record per commit: marker, then fields; name-status lines follow the header line. */
const LOG_FORMAT = "%x1e%H%x1f%P%x1f%ct%x1f%s";
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
  committedAt: string;
  subject: string;
  files: Files;
}

function parseLog(output: string): Map<string, CommitRecord> {
  const commits = new Map<string, CommitRecord>();
  for (const record of output.split("\x1e")) {
    if (record === "") continue;
    const lines = record.split("\n");
    const fields = (lines[0] ?? "").split("\x1f");
    if (fields.length < 4) continue;
    const [sha = "", parentText = "", date = ""] = fields;
    const parents = parentText === "" ? [] : parentText.split(" ");
    const committedAt = unixToIso(date);
    if (!isSha(sha) || !parents.every(isSha) || committedAt === undefined) continue;
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
      committedAt,
      subject: fields.slice(3).join("\x1f"),
      files,
    });
  }
  return commits;
}

const idPart = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);

export const gitImporter: Importer = {
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
    const sourceId = `git:${repo}`;
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

    const listed = await runImportGit(
      repo,
      ["rev-list", "--topo-order", "--reverse", "--branches", "--tags", "--remotes", "--"],
      signal,
    );
    const shas = listed.split("\n").filter((line) => line !== "");
    let sequence = 0;

    for (let start = 0; start < shas.length; start += BATCH_SIZE) {
      if (signal.aborted) return finish();
      const slice = shas.slice(start, start + BATCH_SIZE);
      const valid = slice.filter(isSha);
      counts.read += slice.length;
      counts.malformed += slice.length - valid.length;
      const log =
        valid.length === 0
          ? new Map<string, CommitRecord>()
          : parseLog(
              await runImportGit(
                repo,
                [
                  "log",
                  "--no-walk=unsorted",
                  "--root",
                  "-M",
                  "--no-ext-diff",
                  "--name-status",
                  `--format=${LOG_FORMAT}`,
                  ...valid,
                  "--",
                ],
                signal,
              ),
            );
      const events: InputEventWire[] = [];
      for (const sha of slice) {
        const index = sequence++;
        const c = log.get(sha);
        if (c === undefined) {
          counts.malformed++;
          continue;
        }
        const merge = c.parents.length >= 2;
        events.push(
          event(`commit:${sha}`, c.committedAt, index, "git.commit", {
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
            event(`merge:${sha}`, c.committedAt, index, "git.merge", {
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
    const refOutput = await runImportGit(
      repo,
      ["for-each-ref", `--format=${REF_FORMAT}`, "--", "refs/heads", "refs/remotes", "refs/tags"],
      signal,
    );
    let events: InputEventWire[] = [];
    for (const line of refOutput.split("\n")) {
      if (line === "") continue;
      if (events.length >= BATCH_SIZE) {
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
      if (symref !== "") {
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
