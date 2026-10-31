// `pnpm retro M<n>`: writes docs/retros/M<n>.md from GitHub data (see docs/retros/README.md).
//
// Options:
//   --from <snapshot.json>    render from a recorded snapshot instead of calling GitHub
//   --record <snapshot.json>  also save the snapshot that was read (no personal fields)
//   --out <file>              where to write (default docs/retros/M<n>.md)
//   --now <ISO time>          generation time (default: the current time)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { collect } from "./collect.ts";
import { mermaidBlocks, validateMermaid } from "./mermaid.ts";
import { renderRetro } from "./render.ts";
import type { Snapshot } from "./types.ts";

/** The board holding Size, Lane, Priority, and Phase: GitHub project 2 of the repo owner. */
export const BOARD_PROJECT = 2;
const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const USAGE =
  "Usage: pnpm retro M<n> [--from snapshot.json] [--record snapshot.json] [--out file] [--now ISO-time]";

export type Args = { key: string; from?: string; record?: string; out?: string; now?: string };

export function parseArgs(argv: string[]): Args {
  const [key, ...rest] = argv;
  if (key === undefined || !/^M\d+$/.test(key)) throw new Error(USAGE);
  const args: Args = { key };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (flag === "--from") args.from = value;
    else if (flag === "--record") args.record = value;
    else if (flag === "--out") args.out = value;
    else if (flag === "--now") {
      if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value)))
        throw new Error(USAGE);
      args.now = value;
    } else throw new Error(USAGE);
  }
  return args;
}

export async function main(argv: string[]): Promise<string> {
  const args = parseArgs(argv);
  const now = args.now === undefined ? new Date() : new Date(args.now);
  const snapshot: Snapshot =
    args.from === undefined
      ? await collect({ key: args.key, project: BOARD_PROJECT, now })
      : (JSON.parse(readFileSync(args.from, "utf8")) as Snapshot);
  if (args.record !== undefined) {
    mkdirSync(dirname(args.record), { recursive: true });
    writeFileSync(args.record, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  const out = args.out ?? join(ROOT, "docs", "retros", `${args.key}.md`);
  const existing = existsSync(out) ? readFileSync(out, "utf8") : undefined;
  const template = readFileSync(join(ROOT, "docs", "retros", "TEMPLATE.md"), "utf8");
  const report = renderRetro({ snapshot, template, now, key: args.key, existing });
  const errors = mermaidBlocks(report).flatMap((block) =>
    validateMermaid(block.source).map((e) => `chart at line ${block.line}: ${e}`),
  );
  if (errors.length > 0)
    throw new Error(`Refusing to write invalid Mermaid:\n${errors.join("\n")}`);
  writeFileSync(out, report);
  return out;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (out) => console.log(`Wrote ${out}`),
    (error: Error) => {
      console.error(error.message);
      process.exit(error.message.startsWith("Usage") ? 2 : 1);
    },
  );
}
