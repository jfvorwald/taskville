import { PairingStore } from "@taskville/engine/src/auth/pairing.ts";
import { loadConfig } from "@taskville/engine/src/config/config.ts";
import { ensureHome } from "@taskville/engine/src/config/home.ts";
import { createApp } from "@taskville/engine/src/http/app.ts";
import { LOOPBACK_ADDRESS, startServer } from "@taskville/engine/src/http/server.ts";
import {
  createProject,
  ProjectInputError,
  registerProjectRoutes,
} from "@taskville/engine/src/projects/index.ts";
import { bootEngine, type Engine } from "@taskville/engine/src/stream/index.ts";
import pino from "pino";
import packageJson from "../../package.json" with { type: "json" };
import type { Io } from "../context.ts";
import { type Context, parseCommand } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";

const USAGE = "taskville serve --headless [--port N] [--home <dir>]";

/**
 * `taskville serve --headless`: runs the engine in the foreground on 127.0.0.1 only (contracts/
 * cli.md). Creates the home, tokens, database, and Unsorted project on first run; registers the
 * config file's projects when absent (decision #110 default; the file is never edited); rebuilds
 * stale projections and expires open requests before listening; prints the one-time pairing URL.
 *
 * Pairings stay in memory (MemoryPairingRecords): decision #113 on persisted pairings is still
 * open, so a restart requires pairing the browser again.
 */
export async function serve(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(
    io,
    args,
    { headless: { type: "boolean" }, port: { type: "string" } },
    USAGE,
  );
  const port = values.port === undefined ? undefined : parsePort(values.port as string);
  return run(context, port);
}

function parsePort(text: string): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
    throw new CliError(
      EXIT.failure,
      `--port must be a whole number from 1 to 65535\nUsage: ${USAGE}`,
    );
  }
  return port;
}

async function run(context: Context, portFlag: number | undefined): Promise<number> {
  const { io, home } = context;
  const now = io.now ?? (() => new Date());
  const logger = pino({ level: "info" }, { write: (line: string) => io.stderr(line) });
  let engine: Engine | undefined;
  try {
    const prepared = ensureHome(home);
    const { config, warnings } = loadConfig({ home, port: portFlag });
    for (const warning of warnings) io.stderr(`warning: ${warning}\n`);
    const pairing = new PairingStore();
    const app = createApp({
      port: config.port,
      cliToken: prepared.cliToken,
      bridgeToken: prepared.bridgeToken,
      pairing,
      logger,
      version: packageJson.version,
      health: () => engine?.health() ?? { db: "error", walMode: false },
    });
    engine = bootEngine({ app, dbPath: prepared.paths.db, logger, now, pairing });
    registerProjectRoutes(app, { storage: engine.storage, now });
    for (const project of config.projects) {
      try {
        if (createProject(engine.storage, project, { now })) {
          logger.info({ project: project.id }, "project registered from the config file");
        }
      } catch (error) {
        if (!(error instanceof ProjectInputError)) throw error;
        throw new CliError(EXIT.failure, `Config file project "${project.id}": ${error.message}`);
      }
    }
    const server = await startServer({ app, port: config.port });
    const base = `http://${LOOPBACK_ADDRESS}:${server.port}`;
    io.stdout(`Taskville engine listening on ${base} (home ${home})\n`);
    io.stdout(`Pair a browser (one-time link): ${base}/#pair=${pairing.issueCode()}\n`);
    await new Promise<void>((resolve) => {
      if (io.signal === undefined) return;
      if (io.signal.aborted) resolve();
      else io.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    engine.close();
    await server.close();
    io.stdout("Taskville engine stopped\n");
    return EXIT.ok;
  } catch (error) {
    engine?.close();
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT.failure, `Cannot start the engine: ${(error as Error).message}`);
  }
}
