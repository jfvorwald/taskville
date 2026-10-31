import { isAbsolute, resolve } from "node:path";
import type { CreateProjectResponse, ProjectsResponse } from "@taskville/protocol";
import type { Io } from "../context.ts";
import { parseCommand, printJson, required } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";

const ADD = "taskville project add --name <name> [--id <id>] [--root <dir>]...";
const LIST = "taskville project list";

export async function project(io: Io, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "add") return add(io, rest);
  if (sub === "list") return list(io, rest);
  throw new CliError(EXIT.failure, `Unknown project command\nUsage: ${ADD}\n       ${LIST}`);
}

async function add(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(
    io,
    args,
    { name: { type: "string" }, id: { type: "string" }, root: { type: "string", multiple: true } },
    ADD,
  );
  const name = required(values, "name", ADD);
  const roots = ((values.root as string[] | undefined) ?? []).map((root) =>
    isAbsolute(root) ? resolve(root) : resolve(io.cwd, root),
  );
  const body = { ...(typeof values.id === "string" ? { id: values.id } : {}), name, roots };
  const created = await context.client().json<CreateProjectResponse>("POST", "/v1/projects", body);
  if (context.json) printJson(io, created);
  else io.stdout(`Added project ${created.id} (${created.name})\n`);
  return EXIT.ok;
}

async function list(io: Io, args: string[]): Promise<number> {
  const { context } = parseCommand(io, args, {}, LIST);
  const body = await context.client().json<ProjectsResponse>("GET", "/v1/projects");
  if (context.json) printJson(io, body);
  else {
    for (const p of body.projects) {
      io.stdout(
        `${p.id}\t${p.name}\t${p.roots.length === 0 ? "-" : p.roots.join(",")}\t${p.head}\n`,
      );
    }
  }
  return EXIT.ok;
}
