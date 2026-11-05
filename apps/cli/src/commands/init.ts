import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { slugify } from "@taskville/engine/src/config/config.ts";
import type { CreateProjectResponse, ProjectsResponse } from "@taskville/protocol";
import type { Io } from "../context.ts";
import { parseCommand } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";
import { install } from "./install.ts";

const USAGE = "taskville init [--name <name>] [--yes] [--no-hooks] [--home <dir>] [--url <base>]";
const LATER =
  "To watch Claude Code sessions here later, run: taskville install claude-code --scope project";

/** The Git top-level of the current folder as a real path, or undefined outside a repository. */
function gitTopLevel(io: Io): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: io.cwd, env: { ...process.env, ...io.env }, encoding: "utf8" },
      (error, stdout) => {
        const top = stdout.trim();
        if (error !== null || top === "") return resolve(undefined);
        try {
          resolve(realpathSync(top));
        } catch {
          resolve(top);
        }
      },
    );
  });
}

/** `base`, or `base-2`, `base-3`, ... when a project already has that ID. */
function freeId(base: string, taken: Set<string>): string {
  const root = base === "" ? "project" : base.slice(0, 55);
  let id = root;
  for (let n = 2; taken.has(id); n += 1) id = `${root}-${n}`;
  return id;
}

/**
 * `taskville init`: adds the Git top-level of the current folder as a project (once) and offers
 * the project-scope Claude Code hooks through the same flow as `install` (M7.10).
 */
export async function init(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(
    io,
    args,
    { name: { type: "string" }, yes: { type: "boolean" }, "no-hooks": { type: "boolean" } },
    USAGE,
  );
  const top = await gitTopLevel(io);
  if (top === undefined) {
    throw new CliError(
      EXIT.failure,
      "This folder is not inside a Git repository; run taskville init from your project folder.",
    );
  }
  const name = typeof values.name === "string" && values.name !== "" ? values.name : basename(top);
  const client = context.client();
  const { projects } = await client.json<ProjectsResponse>("GET", "/v1/projects");
  const existing = projects.find((p) => p.roots.includes(top));
  if (existing !== undefined) {
    io.stdout(`${existing.name} is already set up (project ${existing.id}, ${top}).\n`);
  } else {
    const id = freeId(slugify(name), new Set(projects.map((p) => p.id)));
    const created = await client.json<CreateProjectResponse>("POST", "/v1/projects", {
      id,
      name,
      roots: [top],
    });
    io.stdout(`Added project ${created.name} (${created.id}) for ${top}.\n`);
  }

  const next = `Next: open ${context.url} in your browser.\n`;
  if (values["no-hooks"] === true) {
    io.stdout(`${next}${LATER}\n`);
    return EXIT.ok;
  }
  const yes = values.yes === true;
  const ask = io.confirm;
  if (!yes && ask === undefined) {
    io.stdout(`${next}${LATER}\n`);
    return EXIT.ok;
  }
  let declined = false;
  const asking: Io = {
    ...io,
    confirm: async (question) => {
      const answer = await (ask as (q: string) => Promise<boolean>)(question);
      declined = !answer;
      return answer;
    },
  };
  try {
    const code = await install(asking, [
      "claude-code",
      "--scope",
      "project",
      "--project-dir",
      top,
      "--home",
      context.home,
      "--url",
      context.url,
      ...(yes ? ["--yes"] : []),
    ]);
    io.stdout(next);
    return code;
  } catch (error) {
    if (!declined) throw error;
    io.stdout(`${next}${LATER}\n`);
    return EXIT.ok;
  }
}
