import { resolveWebDir } from "@taskville/engine/src/config/web-dir.ts";
import type { Io } from "../context.ts";
import { parseCommand } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";
import { parsePort, runEngine } from "./serve.ts";

/** How many trailing lines of a failed build's stderr the error carries. */
const BUILD_TAIL_LINES = 8;

const USAGE = "taskville start [--port N] [--no-open] [--verbose] [--home <dir>]";

/**
 * `taskville start`: the engine in the foreground for a person at a terminal (contracts/cli.md).
 * Builds the web client once when it is missing and this is a source checkout, opens the
 * one-time pairing link in the browser (terminal only, not with `--no-open`), keeps the console
 * quiet, and reports a running engine instead of starting a second one.
 */
export async function start(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(
    io,
    args,
    {
      port: { type: "string" },
      "no-open": { type: "boolean" },
      verbose: { type: "boolean" },
    },
    USAGE,
  );
  const port = values.port === undefined ? undefined : parsePort(values.port as string);
  return runEngine(
    context,
    port,
    { command: "start", open: values["no-open"] !== true, verbose: values.verbose === true },
    () => ensureWebClient(io),
  );
}

async function ensureWebClient(io: Io): Promise<void> {
  const web = resolveWebDir(io.env);
  if (web.dir !== undefined) return;
  if (io.sourceCheckout !== true || io.buildWeb === undefined) {
    throw new CliError(
      EXIT.failure,
      `The web client is not built (no index.html in ${web.missing}) and there is no source here to build it from; reinstall Taskville or set TASKVILLE_WEB_DIR.`,
    );
  }
  io.stdout("Building the web client (first run only)...\n");
  try {
    await io.buildWeb();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const tail =
      typeof stderr === "string" && stderr.trim() !== ""
        ? `\n${stderr.trimEnd().split("\n").slice(-BUILD_TAIL_LINES).join("\n")}`
        : "";
    throw new CliError(
      EXIT.failure,
      `Building the web client failed: ${(error as Error).message}${tail}`,
    );
  }
  if (resolveWebDir(io.env).dir === undefined) {
    throw new CliError(
      EXIT.failure,
      `The web client build produced no index.html in ${web.missing}.`,
    );
  }
}
