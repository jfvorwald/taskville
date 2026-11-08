import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ImportStarted, ImportStatusWire, ProjectsResponse } from "@taskville/protocol";
import { isAbort } from "../client.ts";
import type { Io } from "../context.ts";
import { parseCommand, printJson } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";

const USAGE = "taskville import git|transcripts [--project <id>] [--root <path>] [--json]";
const KINDS = ["git", "transcripts"];
const DEFAULT_POLL_MS = 500;

/** The engine's refusals, in words for a terminal. Codes are matched as strings. */
const REFUSALS = new Map<string, (root: string) => string>([
  [
    "root_not_configured",
    (root) =>
      `${root} is not a configured root of the project; add it with \`taskville project add --root <dir>\` or pick one with --root`,
  ],
  ["import_running", () => "An import is already running for this project; wait for it to finish"],
  ["unknown_import_kind", () => "The engine has no importer for that kind (not available)"],
  ["engine_closing", () => "The engine is shutting down; try again once it is back"],
]);

/** Consecutive status reads that may fail before the command gives up. */
const MAX_POLL_FAILURES = 5;

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function contains(root: string, path: string): boolean {
  const rel = relative(real(root), real(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

type Projects = ProjectsResponse["projects"];

/**
 * The deepest configured root that contains `path`, with its project. Projects whose deepest
 * roots resolve to the same real path are a tie, reported as `tied` (their IDs).
 */
function locate(projects: Projects, path: string, only?: string) {
  let best: { projectId: string; root: string } | undefined;
  let tied: string[] = [];
  for (const p of projects) {
    if (only !== undefined && p.id !== only) continue;
    for (const root of p.roots) {
      if (!contains(root, path)) continue;
      const depth = real(root).length;
      const bestDepth = best === undefined ? -1 : real(best.root).length;
      if (depth > bestDepth) {
        best = { projectId: p.id, root };
        tied = [p.id];
      } else if (depth === bestDepth && best !== undefined && real(root) === real(best.root)) {
        if (!tied.includes(p.id)) tied.push(p.id);
      }
    }
  }
  return { best, tied };
}

/** Waits `ms`, or until the signal aborts; the abort listener never outlives the timer. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** A status read worth trying again: the engine did not answer, or answered 5xx. */
const transient = (error: unknown): boolean =>
  error instanceof CliError &&
  (error.code === EXIT.unreachable || /^Engine error 5\d\d/.test(error.message));

const progress = (c: ImportStatusWire["counts"]) =>
  `read ${c.read}, imported ${c.imported}, skipped ${c.skipped}, malformed ${c.malformed}`;

function interrupted(io: Io, id: string): number {
  io.stderr(`Interrupted; import ${id} keeps running on the engine\n`);
  return EXIT.failure;
}

/** `taskville import git|transcripts`: starts an import, polls it and prints counts (M8.08). */
export async function importCommand(io: Io, args: string[]): Promise<number> {
  const first = args[0];
  const kind = first !== undefined && !first.startsWith("-") ? first : undefined;
  if (kind === undefined || !KINDS.includes(kind)) {
    throw new CliError(
      EXIT.failure,
      `import needs a kind: git or transcripts${kind === undefined ? "" : ` (got "${kind}")`}\nUsage: ${USAGE}`,
    );
  }
  const { values, context } = parseCommand(
    io,
    args.slice(1),
    { project: { type: "string" }, root: { type: "string" } },
    USAGE,
  );
  const client = context.client();
  const flagProject = typeof values.project === "string" ? values.project : undefined;
  const flagRoot =
    typeof values.root === "string"
      ? isAbsolute(values.root)
        ? resolve(values.root)
        : resolve(io.cwd, values.root)
      : undefined;
  let projectId = flagProject;
  let root = flagRoot;
  if (projectId === undefined || root === undefined) {
    const { projects } = await client.json<ProjectsResponse>("GET", "/v1/projects");
    const { best, tied } = locate(projects, flagRoot ?? io.cwd, flagProject);
    if (tied.length > 1) {
      throw new CliError(
        EXIT.failure,
        `More than one project owns that root (${tied.join(", ")}); pass --project <id>`,
      );
    }
    let found = best;
    if (found === undefined && flagProject !== undefined && flagRoot === undefined) {
      // Outside every root of the named project: its only root is the default.
      const roots = projects.find((p) => p.id === flagProject)?.roots ?? [];
      if (roots.length > 1) {
        throw new CliError(
          EXIT.failure,
          `Project ${flagProject} has several roots (${roots.join(", ")}); pass --root <path>`,
        );
      }
      if (roots[0] !== undefined) found = { projectId: flagProject, root: roots[0] };
    }
    if (found === undefined) {
      throw new CliError(
        EXIT.failure,
        `No project root contains ${flagRoot ?? io.cwd}; pass --project <id> and --root <path>`,
      );
    }
    projectId ??= found.projectId;
    root ??= found.root;
  }

  let started: ImportStarted;
  try {
    started = await client.json<ImportStarted>("POST", "/v1/imports", { projectId, kind, root });
  } catch (error) {
    if (isAbort(error) || io.signal?.aborted) {
      io.stderr(
        "Interrupted while starting the import; it may already be running on the engine. Run `taskville import` again: import_running means it is, or check `taskville status`.\n",
      );
      return EXIT.failure;
    }
    const code =
      error instanceof CliError ? /^Engine error \d+ \((\w+)\)/.exec(error.message) : null;
    const refusal = code?.[1] === undefined ? undefined : REFUSALS.get(code[1]);
    if (refusal === undefined) throw error;
    throw new CliError(EXIT.failure, refusal(root));
  }

  const pollMs = io.importPollMs ?? DEFAULT_POLL_MS;
  const id = started.importId;
  let last = "";
  let failures = 0;
  for (;;) {
    let record: ImportStatusWire;
    try {
      record = await client.json<ImportStatusWire>("GET", `/v1/imports/${id}`);
      failures = 0;
    } catch (error) {
      if (isAbort(error) || io.signal?.aborted) return interrupted(io, id);
      if (error instanceof CliError && /^Engine error 404/.test(error.message)) {
        throw new CliError(EXIT.notFound, `Import ${id} not found on the engine`);
      }
      if (!transient(error)) throw error;
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        throw new CliError(
          EXIT.failure,
          `Import ${id} was started on the engine, but taskville could not read its status (${(error as Error).message}); it may still be running`,
        );
      }
      await sleep(pollMs, io.signal);
      continue;
    }
    if (record.status === "running") {
      const line = progress(record.counts);
      if (!context.json && line !== last) io.stdout(`Importing ${kind}: ${line}\n`);
      last = line;
      if (io.signal?.aborted) return interrupted(io, id);
      await sleep(pollMs, io.signal);
      continue;
    }
    if (context.json) {
      printJson(io, record);
    } else if (record.status === "done") {
      io.stdout(`Import done: ${progress(record.counts)}\n`);
      const byCode = Object.entries(record.counts.malformedByCode ?? {});
      if (byCode.length > 0)
        io.stdout(`Malformed by code: ${byCode.map(([c, n]) => `${c} ${n}`).join(", ")}\n`);
      if (record.counts.truncated === true) {
        io.stdout(
          "The import was truncated at the engine's event limit; later events were left out.\n",
        );
      }
    } else if (record.status === "failed") {
      const why =
        record.error === undefined ? "" : ` (${record.error.code}): ${record.error.message}`;
      io.stderr(`Import failed${why}\n`);
    } else if (record.status === "cancelled") {
      io.stderr(`Import cancelled: ${progress(record.counts)}\n`);
    } else {
      io.stderr(`import ended with status ${String(record.status)}\n`);
    }
    return record.status === "done" ? EXIT.ok : EXIT.failure;
  }
}
