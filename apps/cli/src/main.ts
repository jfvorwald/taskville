// `taskville`: the command-line client and the engine launcher (contracts/cli.md).

import { demo } from "./commands/demo.ts";
import { events } from "./commands/events.ts";
import { install, uninstall } from "./commands/install.ts";
import { project } from "./commands/projects.ts";
import { requests } from "./commands/requests.ts";
import { serve } from "./commands/serve.ts";
import { status } from "./commands/status.ts";
import { unpair } from "./commands/unpair.ts";
import type { Io } from "./context.ts";
import { CliError, EXIT } from "./errors.ts";

export type { Io } from "./context.ts";

const USAGE = `Usage: taskville <command> [options]

Commands:
  serve --headless [--port N]                 Run the engine on 127.0.0.1
  project add --name <name> [--id <id>] [--root <dir>]...
  project list
  status --project <id> [--all]               Agents as an indented tree
  events ingest --file <path.jsonl>           Post events from a JSONL file
  events follow --project <id> [--after N]    Stream events
  requests [--project <id>] [--all]           List pending requests (read-only)
  unpair                                      Revoke every paired browser
  install claude-code --scope user|project [--project-dir <dir>] [--yes] [--dry-run]
  uninstall claude-code --scope user|project [--project-dir <dir>] [--yes] [--dry-run]
  demo run --offline --seed <n> --duration <t> [--pace <pace>]
  demo start --project <id> --seed <n> [--pace <pace>] [--speed <x>] [--duration <t>]

Global options: --home <dir>, --url <base>, --json
`;

const COMMANDS: Record<string, (io: Io, args: string[]) => Promise<number>> = {
  serve,
  project,
  status,
  events,
  requests,
  unpair,
  demo,
  install,
  uninstall,
};

export async function run(argv: string[], io: Io): Promise<number> {
  const [name, ...args] = argv;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (command === undefined || !Object.hasOwn(COMMANDS, name ?? "")) {
    io.stderr(
      name === undefined || name === "--help" ? USAGE : `Unknown command "${name}"\n${USAGE}`,
    );
    return name === "--help" ? EXIT.ok : EXIT.failure;
  }
  try {
    return await command(io, args);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`taskville: ${error.message}\n`);
      return error.code;
    }
    io.stderr(`taskville: ${(error as Error).stack ?? String(error)}\n`);
    return EXIT.failure;
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => controller.abort());
  run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    signal: controller.signal,
    confirm: process.stdin.isTTY ? askOnTerminal : undefined,
  }).then((code) => {
    process.exitCode = code;
  });
}

/** A y/N question on the terminal (install and uninstall). Anything but y or yes is no. */
async function askOnTerminal(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
