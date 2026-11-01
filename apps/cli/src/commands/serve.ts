import {
  PAIRING_CODE_TTL_MS,
  type PairingRecords,
  PairingStore,
} from "@taskville/engine/src/auth/pairing.ts";
import { wirePermissionBridge } from "@taskville/engine/src/bridge/wire.ts";
import { loadConfig } from "@taskville/engine/src/config/config.ts";
import { ensureHome } from "@taskville/engine/src/config/home.ts";
import { resolveWebDir } from "@taskville/engine/src/config/web-dir.ts";
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
import type { Io, KeyInput } from "../context.ts";
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
 * Pairing (M2.12; decisions #113, #163, #174 defaults):
 * - Paired browsers are persisted as SHA-256 digests in the `pairings` table, so a paired page
 *   survives a restart against the same home; `taskville unpair` clears them. Codes are never
 *   persisted.
 * - On a terminal, pressing `p` prints a fresh one-time link, valid for 10 minutes, to this
 *   terminal only. No HTTP route, IPC, or signal mints a code. At most one code per second, at
 *   most five outstanding (the oldest is dropped past that); earlier codes keep working until
 *   used or expired. Raw mode turns Ctrl-C into a byte, which stops the engine like SIGINT; the
 *   terminal is restored on every exit path.
 * - Without a terminal (stdin not a TTY), the one link at startup is all; a new one needs a
 *   restart, and `serve` says so.
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

/** Keypress codes: at most one per second, however many keys arrive. */
export const PAIRING_KEY_INTERVAL_MS = 1000;
/** Unexpired, unused codes `serve` keeps at once; past this the oldest stops working. */
export const MAX_OUTSTANDING_CODES = 5;

/** What `composeServe` builds, before anything listens. */
export interface ServeParts {
  app: ReturnType<typeof createApp>;
  pairing: PairingStore;
  port: number;
  gitWatcher: GitWatcher;
  /** The Claude Code source and spool folder, for the spool replay (M2.07). */
  spool: Parameters<typeof replaySpool>[0];
  /** Stops the Git watcher and closes the databases. */
  close(): Promise<void>;
}

/**
 * The persisted pairing records arrive with storage, which `bootEngine` opens after `createApp`
 * needs the `PairingStore`. Nothing can pair before the server listens, which is after boot.
 */
class DeferredPairingRecords implements PairingRecords {
  #target: PairingRecords | undefined;

  attach(target: PairingRecords): void {
    this.#target = target;
  }

  list(): readonly string[] {
    return this.#target?.list() ?? [];
  }

  add(secretHash: string): void {
    if (this.#target === undefined) throw new Error("pairing records used before storage opened");
    this.#target.add(secretHash);
  }

  clear(): number {
    return this.#target?.clear() ?? 0;
  }
}

/**
 * Builds the engine for `serve` without listening: home, config, app with its security
 * middleware, storage, every route, the evidence store, and the Git watcher (not started).
 * Exported so the route table can be tested.
 */
export function composeServe(io: Io, home: string, portFlag: number | undefined): ServeParts {
  const now = io.now ?? (() => new Date());
  const logger = pino({ level: "info" }, { write: (line: string) => io.stderr(line) });
  let engine: Engine | undefined;
  let evidence: EvidenceStore | undefined;
  let gitWatcher: GitWatcher | undefined;
  let wired: ReturnType<typeof wirePermissionBridge> | undefined;
  const close = async () => {
    // First, so no held hook response keeps the server from closing.
    wired?.close();
    await gitWatcher?.stop();
    engine?.close();
    evidence?.close();
  };
  try {
    const prepared = ensureHome(home);
    const { config, warnings } = loadConfig({ home, port: portFlag });
    for (const warning of warnings) io.stderr(`warning: ${warning}\n`);
    const web = resolveWebDir(io.env);
    if (web.dir === undefined) {
      io.stderr(
        `warning: the web client is not built (no index.html in ${web.missing}); run pnpm --filter @taskville/web build\n`,
      );
    }
    const records = new DeferredPairingRecords();
    const pairing = new PairingStore({ records, maxPendingCodes: MAX_OUTSTANDING_CODES });
    const app = createApp({
      port: config.port,
      cliToken: prepared.cliToken,
      bridgeToken: prepared.bridgeToken,
      pairing,
      logger,
      ...(web.dir === undefined ? {} : { staticDir: web.dir }),
      version: packageJson.version,
      health: () => engine?.health() ?? { db: "error", walMode: false },
    });
    engine = bootEngine({ app, dbPath: prepared.paths.db, logger, now, pairing });
    // Persisted pairings (#113 default): digests in the `pairings` table.
    records.attach(engine.storage.pairingRecords());
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
    // The permission bridge and the command service (M4.04): held hook responses, the commands
    // that answer them, and live PostToolUse telemetry closing a request answered in the terminal.
    wired = wirePermissionBridge({ app, engine, config, logger, now });
    registerClaudeCodeRoutes(app, claudeCode, { observeHook: wired.observeHook });
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
    const spool = { spoolDir: prepared.paths.spoolDir, source: claudeCode, logger };
    return { app, pairing, port: config.port, gitWatcher, spool, close };
  } catch (error) {
    void close();
    throw error;
  }
}

async function run(context: Context, portFlag: number | undefined): Promise<number> {
  const { io, home } = context;
  const now = io.now ?? (() => new Date());
  let parts: ServeParts | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let keys: { restore: () => void } | undefined;
  const stopDrain = new AbortController();
  let draining: Promise<unknown> = Promise.resolve();
  try {
    parts = composeServe(io, home, portFlag);
    const { pairing, spool } = parts;
    // Spooled telemetry (M2.07), after the config projects so their roots route it: one bounded
    // run before listening, the rest worked off in bounded runs afterwards.
    const first = await replaySpool(spool);
    server = await startServer({ app: parts.app, port: parts.port });
    parts.gitWatcher.start();
    if (!first.failed && (first.deferredFiles > 0 || first.mainFile === "busy")) {
      draining = drainSpool({ ...spool, signal: stopDrain.signal }).catch((error: unknown) => {
        spool.logger?.error({ errName: (error as Error).name }, "spool drain failed");
      });
    }
    const base = `http://${LOOPBACK_ADDRESS}:${server.port}`;
    io.stdout(`Taskville engine listening on ${base} (home ${home})\n`);
    const minutes = PAIRING_CODE_TTL_MS / 60_000;
    // The code is printed to this terminal only, never logged.
    const printLink = () =>
      io.stdout(
        `Pair a browser (one-time link, valid for ${minutes} minutes): ${base}/#pair=${pairing.issueCode()}\n`,
      );
    printLink();

    let interrupt: () => void = () => {};
    const interrupted = new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    let lastKeyCode = Number.NEGATIVE_INFINITY;
    keys = listenForKeys(io.stdin, {
      pair: () => {
        const t = now().getTime();
        // A clock that went back does not lock the key out.
        if (t - lastKeyCode < PAIRING_KEY_INTERVAL_MS && t >= lastKeyCode) return;
        lastKeyCode = t;
        printLink();
      },
      interrupt: () => interrupt(),
    });
    io.stdout(
      keys === undefined
        ? "For a new pairing link later, restart taskville serve.\n"
        : `Press p for a new pairing link (valid for ${minutes} minutes); Ctrl-C stops the engine.\n`,
    );
    try {
      await Promise.race([
        interrupted,
        new Promise<void>((resolve) => {
          if (io.signal === undefined) return;
          if (io.signal.aborted) resolve();
          else io.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    } finally {
      keys?.restore();
    }
    stopDrain.abort();
    await draining;
    await parts.close();
    const listening = server;
    server = undefined;
    await listening.close();
    io.stdout("Taskville engine stopped\n");
    return EXIT.ok;
  } catch (error) {
    // Never leave the terminal raw, whatever failed.
    keys?.restore();
    stopDrain.abort();
    await draining;
    await parts?.close();
    // A failure after listening (a closed terminal, say) must not leave the port open.
    await server?.close().catch(() => {});
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT.failure, `Cannot start the engine: ${(error as Error).message}`);
  }
}

/**
 * Raw-mode keys on a TTY only: `p` (or `P`) asks for a new link, Ctrl-C (a byte in raw mode)
 * stops. One request per chunk at most, so a pasted run of keys counts once. Returns undefined,
 * touching nothing, when `stdin` is missing or not a terminal, and undefined after undoing any
 * partial setup when the terminal refuses raw mode. `restore` leaves raw mode, stops
 * reading, and is also registered for process exit, so the terminal is never left raw.
 */
function listenForKeys(
  stdin: KeyInput | undefined,
  handlers: { pair: () => void; interrupt: () => void },
): { restore: () => void } | undefined {
  if (stdin === undefined || stdin.isTTY !== true || typeof stdin.setRawMode !== "function") {
    return undefined;
  }
  const onData = (chunk: Buffer | string) => {
    const keys = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (keys.includes("\u0003")) handlers.interrupt();
    else if (/[pP]/.test(keys)) handlers.pair();
  };
  let restored = false;
  let raw = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.off("exit", restore);
    stdin.off("data", onData);
    try {
      if (raw) stdin.setRawMode?.(false);
    } catch {
      // The terminal may already be gone; nothing left to restore.
    } finally {
      stdin.pause();
    }
  };
  try {
    stdin.setRawMode(true);
    raw = true;
    stdin.on("data", onData);
    stdin.resume();
    process.once("exit", restore);
  } catch {
    // A terminal that cannot go raw (closed, or not really a TTY): undo what was done and fall
    // back to the no-terminal behavior instead of failing a running engine.
    restore();
    return undefined;
  }
  return { restore };
}
