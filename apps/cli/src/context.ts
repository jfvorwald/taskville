import { type ParseArgsConfig, parseArgs } from "node:util";
import { resolveHome } from "@taskville/engine/src/config/home.ts";
import { DEFAULT_URL, EngineClient, readToken } from "./client.ts";
import { CliError, EXIT } from "./errors.ts";

/** Where the CLI reads and writes; injected so tests run it in process. */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Aborted on SIGINT or SIGTERM; ends `serve` and `events follow`. */
  signal?: AbortSignal | undefined;
  /** Engine clock for `serve` (tests); defaults to the system clock. */
  now?: (() => Date) | undefined;
  /** Asks a yes/no question on the terminal; absent when stdin is not a TTY (`install`). */
  confirm?: ((question: string) => Promise<boolean>) | undefined;
  /** The terminal's input, for `serve`'s keypress (M2.12). Used only when it is a TTY. */
  stdin?: KeyInput | undefined;
}

/** The part of `process.stdin` that `serve` uses. */
export interface KeyInput {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Options every command accepts (contracts/cli.md). */
export const GLOBAL: Options = {
  home: { type: "string" },
  url: { type: "string" },
  json: { type: "boolean" },
};

export interface Context {
  io: Io;
  home: string;
  url: string;
  json: boolean;
  client(): EngineClient;
}

export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

/** Parses a command's own options plus the global ones; no positionals. Usage errors exit 1. */
export function parseCommand(io: Io, args: string[], options: Options, usage: string) {
  let values: Values;
  try {
    ({ values } = parseArgs({
      args,
      options: { ...GLOBAL, ...options },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new CliError(EXIT.failure, `${(error as Error).message}\nUsage: ${usage}`);
  }
  const home = resolveHome({ flag: values.home as string | undefined, env: io.env, cwd: io.cwd });
  const url = (values.url as string | undefined) ?? io.env.TASKVILLE_URL ?? DEFAULT_URL;
  const context: Context = {
    io,
    home,
    url,
    json: values.json === true,
    client: () => new EngineClient({ url, token: readToken(home), signal: io.signal }),
  };
  return { values, context };
}

export function required(values: Values, name: string, usage: string): string {
  const value = values[name];
  if (typeof value !== "string" || value === "") {
    throw new CliError(EXIT.failure, `--${name} is required\nUsage: ${usage}`);
  }
  return value;
}

export function printJson(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}
