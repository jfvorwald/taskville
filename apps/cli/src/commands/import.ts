import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ImportStarted, ImportStatusWire, ProjectsResponse } from "@taskville/protocol";
import type { Io } from "../context.ts";
import { parseCommand, printJson } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";

const USAGE = "taskville import git|transcripts [--project <id>] [--root <path>] [--json]";
const KINDS = ["git", "transcripts"];
const DEFAULT_POLL_MS = 500;

/** The engine's refusals, in words for a terminal. Codes are matched as strings. */
const REFUSALS: Record<string, (root: string) => string> = {
  root_not_configured: (root) =>
    `${root} is not a configured root of the project; add it with \`taskville project add --root <dir>\` or pick one with --root`,
  import_running: () => "An import is already running for this project; wait for it to finish",
  unknown_import_kind: (_root) => "The engine has no importer for that kind (not available)",
  engine_closing: () => "The engine is shutting down; try again once it is back",
};

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function contains(root: string, path: string): boolean {
  const rel = relative(real(root), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The deepest configured root that contains `path`, with its project. */
function locate(projects: ProjectsResponse["projects"], path: string, only?: string) {
  let best: { projectId: string; root: string } | undefined;
  for (const p of projects) {
    if (only !== undefined && p.id !== only) continue;
    for (const root of p.roots) {
      if (!contains(root, path)) continue;
      if (best === undefined || real(root).length > real(best.root).length) {
        best = { projectId: p.id, root };
      }
    }
  }
  return best;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
}

const progress = (c: ImportStatusWire["counts"]) =>
  `read ${c.read}, imported ${c.imported}, skipped ${c.skipped}, malformed ${c.malformed}`;

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
    const found = locate(projects, flagRoot ?? io.cwd, flagProject);
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
    const code =
      error instanceof CliError ? /^Engine error \d+ \((\w+)\)/.exec(error.message) : null;
    const refusal = code?.[1] === undefined ? undefined : REFUSALS[code[1]];
    if (refusal === undefined) throw error;
    throw new CliError(EXIT.failure, refusal(root));
  }

  const pollMs = io.importPollMs ?? DEFAULT_POLL_MS;
  let last = "";
  for (;;) {
    const record = await client.json<ImportStatusWire>("GET", `/v1/imports/${started.importId}`);
    if (record.status === "running") {
      const line = progress(record.counts);
      if (!context.json && line !== last) io.stdout(`Importing ${kind}: ${line}\n`);
      last = line;
      if (io.signal?.aborted) return EXIT.failure;
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
    } else {
      io.stderr(`Import cancelled: ${progress(record.counts)}\n`);
    }
    return record.status === "done" ? EXIT.ok : EXIT.failure;
  }
}
