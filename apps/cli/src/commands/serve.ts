import { PAIRING_CODE_TTL_MS, PairingStore } from "@taskville/engine/src/auth/pairing.ts";
import { loadConfig } from "@taskville/engine/src/config/config.ts";
import { ensureHome } from "@taskville/engine/src/config/home.ts";
import { type EvidenceStore, openEvidenceStore } from "@taskville/engine/src/evidence/index.ts";
import { createApp } from "@taskville/engine/src/http/app.ts";
import { LOOPBACK_ADDRESS, startServer } from "@taskville/engine/src/http/server.ts";
import {
  createProject,
  ProjectInputError,
  registerProjectRoutes,
} from "@taskville/engine/src/projects/index.ts";
import {
  ClaudeCodeSource,
  drainSpool,
  mapClaudeCodeHook,
  registerClaudeCodeRoutes,
  replaySpool,
} from "@taskville/engine/src/sources/claude-code/index.ts";
import { GitWatcher } from "@taskville/engine/src/sources/git/index.ts";
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
 * stale projections, expires open requests, and replays the telemetry spool (bounded; any rest
 * is drained after listening) before listening; prints the one-time pairing URL.
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
  let evidence: EvidenceStore | undefined;
  let gitWatcher: GitWatcher | undefined;
  const stopDrain = new AbortController();
  let draining: Promise<unknown> = Promise.resolve();
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
    // Claude Code telemetry (M2.02, M2.03, M2.06): hooks from the shim, tool bodies to evidence.db.
    evidence = openEvidenceStore(prepared.paths.evidenceDb, { now, logger });
    const claudeCode = new ClaudeCodeSource({
      pipeline: engine.pipeline,
      storage: engine.storage,
      mapper: mapClaudeCodeHook,
      evidence,
      logger,
      now,
    });
    registerClaudeCodeRoutes(app, claudeCode);
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
    // Live Git watcher (ARCHITECTURE.md 8.2): read-only, over every project's roots, through the
    // same ingest pipeline as producers.
    const pipeline = engine.pipeline;
    gitWatcher = new GitWatcher({
      storage: engine.storage,
      ingest: (events) => pipeline.ingest(events),
      now,
      logger,
    });
    // Spooled telemetry (M2.07), after the config projects so their roots route it: one bounded
    // run before listening, the rest worked off in bounded runs afterwards.
    const spool = { spoolDir: prepared.paths.spoolDir, source: claudeCode, logger };
    const first = await replaySpool(spool);
    const server = await startServer({ app, port: config.port });
    gitWatcher.start();
    if (!first.failed && (first.deferredFiles > 0 || first.mainFile === "busy")) {
      draining = drainSpool({ ...spool, signal: stopDrain.signal }).catch((error: unknown) => {
        logger.error({ errName: (error as Error).name }, "spool drain failed");
      });
    }
    const base = `http://${LOOPBACK_ADDRESS}:${server.port}`;
    io.stdout(`Taskville engine listening on ${base} (home ${home})\n`);
    const minutes = PAIRING_CODE_TTL_MS / 60_000;
    io.stdout(
      `Pair a browser (one-time link, valid for ${minutes} minutes): ${base}/#pair=${pairing.issueCode()}\n`,
    );
    await new Promise<void>((resolve) => {
      if (io.signal === undefined) return;
      if (io.signal.aborted) resolve();
      else io.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    stopDrain.abort();
    await draining;
    await gitWatcher.stop();
    engine.close();
    evidence.close();
    await server.close();
    io.stdout("Taskville engine stopped\n");
    return EXIT.ok;
  } catch (error) {
    stopDrain.abort();
    await draining;
    await gitWatcher?.stop();
    engine?.close();
    evidence?.close();
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT.failure, `Cannot start the engine: ${(error as Error).message}`);
  }
}
