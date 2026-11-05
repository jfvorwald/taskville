import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import { registerFeedRoutes } from "@taskville/engine/src/feed/index.ts";
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
import { registerOtlpRoutes } from "@taskville/engine/src/sources/otlp/index.ts";
import { bootEngine, type Engine } from "@taskville/engine/src/stream/index.ts";
import pino from "pino";
import packageJson from "../../package.json" with { type: "json" };
import type { Io, KeyInput } from "../context.ts";
import { type Context, parseCommand } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";

const USAGE = "taskville serve --headless [--port N] [--verbose] [--home <dir>]";

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
    { headless: { type: "boolean" }, port: { type: "string" }, verbose: { type: "boolean" } },
    USAGE,
  );
  const port = values.port === undefined ? undefined : parsePort(values.port as string);
  return runEngine(context, port, {
    command: "serve",
    open: false,
    verbose: values.verbose === true,
  });
}

export function parsePort(text: string, usage: string = USAGE): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
    throw new CliError(
      EXIT.failure,
      `--port must be a whole number from 1 to 65535\nUsage: ${usage}`,
    );
  }
  return port;
}

/** Keypress codes: at most one per second, however many keys arrive. */
export const PAIRING_KEY_INTERVAL_MS = 1000;
/** Unexpired, unused codes `serve` keeps at once; past this the oldest stops working. */
export const MAX_OUTSTANDING_CODES = 5;

/** Where JSON log lines go: `<home>/logs/engine.log` (private) and/or stderr. */
export interface LogRouting {
  file: boolean;
  stderr: boolean;
}

function logDestination(io: Io, home: string, logging: LogRouting) {
  let logFile: string | undefined;
  if (logging.file) {
    const dir = join(home, "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    logFile = join(dir, "engine.log");
    appendFileSync(logFile, "", { mode: 0o600 });
    chmodSync(logFile, 0o600);
  }
  return {
    write: (line: string) => {
      if (logFile !== undefined) appendFileSync(logFile, line);
      if (logging.stderr) io.stderr(line);
    },
  };
}

/** How `runEngine` behaves for `serve` and `start`. */
export interface EngineMode {
  command: "serve" | "start";
  /** Open the pairing link in the browser (start, on a terminal). */
  open: boolean;
  verbose: boolean;
}

/** `<home>/engine.json`: the running engine's address, for the next `start` to find. */
interface RuntimeInfo {
  url: string;
  pid: number;
  startedAt: string;
}

const RUNTIME_FILE = "engine.json";

/**
 * The loopback origin in an `engine.json` url, or undefined for anything else: the file is
 * untrusted input, so no other host, scheme, path, query or user info is ever fetched or printed.
 */
function loopbackOrigin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const plain = url.pathname === "/" && url.search === "" && url.hash === "";
  const noUser = url.username === "" && url.password === "";
  return plain && noUser && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url.origin)
    ? url.origin
    : undefined;
}

/** The URL of a live engine recorded in `<home>/engine.json`: its pid is alive and /health answers. */
async function liveEngine(home: string): Promise<string | undefined> {
  let info: Partial<RuntimeInfo>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, RUNTIME_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    info = parsed as Partial<RuntimeInfo>;
  } catch {
    return undefined;
  }
  if (typeof info.url !== "string" || typeof info.pid !== "number") return undefined;
  const origin = loopbackOrigin(info.url);
  if (origin === undefined) return undefined;
  if (!Number.isInteger(info.pid) || info.pid < 1 || info.pid > 2147483647) return undefined;
  try {
    process.kill(info.pid, 0);
  } catch (error) {
    // EPERM means the process exists but is not ours.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  try {
    await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    return origin;
  } catch {
    return undefined;
  }
}

const LOCK_FILE = "engine.lock";
/** How long a start waits for another start's lock before giving up. */
const LOCK_WAIT_MS = 10_000;
/** An unparsable lock younger than this may still be mid-write by its owner. */
const LOCK_UNPARSABLE_GRACE_MS = 3000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes `<home>/engine.lock` (O_EXCL, 0600, the pid as text), waiting a bounded time for a live
 * holder and taking over one whose pid is dead. O_EXCL never follows a symlink at the path. A
 * stale lock is renamed aside first (only one taker's rename succeeds) and checked before it is
 * dropped, so a lock another start just created is never removed. A non-regular file at the path
 * fails at once. Every retry awaits. Returns an idempotent release.
 */
const RECLAIM_GRACE_MS = 5000;

/**
 * Removes `path` if it still holds exactly `seen` (a lock judged stale), while holding
 * `<path>.reclaim`. Returns true to retry at once, false when another live taker holds the mutex.
 * A reclaim file is cleared only when its pid is dead (or it has no pid and is old).
 */
async function reclaimStale(
  path: string,
  seen: string,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  const mutex = `${path}.reclaim`;
  let fd: number;
  try {
    fd = openSync(mutex, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new CliError(EXIT.failure, `Cannot create ${mutex}; check its permissions and retry.`);
    }
    let stat: ReturnType<typeof lstatSync>;
    let text: string;
    try {
      stat = lstatSync(mutex);
      if (!stat.isFile()) {
        throw new CliError(EXIT.failure, `${mutex} is not a regular file; remove it and retry.`);
      }
      text = readFileSync(mutex, "utf8");
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw new CliError(EXIT.failure, `Cannot read ${mutex}; check its permissions and retry.`);
    }
    // Cleared only when its holder is gone: a dead pid, or no pid written long ago (a crash
    // between create and write). A live holder is never preempted, however slow (roborev 7045).
    const pid = Number(text.trim());
    const gone =
      Number.isInteger(pid) && pid > 0 ? !alive(pid) : Date.now() - stat.mtimeMs > RECLAIM_GRACE_MS;
    if (gone) {
      rmSync(mutex, { force: true });
      return true;
    }
    return false;
  }
  try {
    writeFileSync(fd, `${process.pid}`);
  } finally {
    closeSync(fd);
  }
  try {
    let now: string | undefined;
    try {
      now = readFileSync(path, "utf8");
    } catch {
      now = undefined;
    }
    if (now === seen) rmSync(path, { force: true });
  } finally {
    rmSync(mutex, { force: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return true;
}

export async function acquireLock(
  home: string,
  deps: { pidAlive?: (pid: number) => boolean; waitMs?: number } = {},
): Promise<() => void> {
  const alive = deps.pidAlive ?? pidAlive;
  const path = join(home, LOCK_FILE);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (deps.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${process.pid}`);
      } finally {
        closeSync(fd);
      }
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        try {
          if (readFileSync(path, "utf8").trim() === `${process.pid}`) unlinkSync(path);
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let seen: string | undefined;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) {
        throw new CliError(EXIT.failure, `${path} is not a regular file; remove it and retry.`);
      }
      seen = readFileSync(path, "utf8");
      const pid = Number(seen.trim());
      const stale =
        Number.isInteger(pid) && pid > 0
          ? !alive(pid)
          : Date.now() - stat.mtimeMs > LOCK_UNPARSABLE_GRACE_MS;
      if (!stale) seen = undefined;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CliError(EXIT.failure, `Cannot read ${path}; check its permissions and retry.`);
      }
      // Released between our create attempt and the read: try again after a turn.
      await new Promise((resolve) => setTimeout(resolve, 0));
      continue;
    }
    if (seen !== undefined) {
      // Reclaiming a stale lock is serialized by a second O_EXCL file, so no taker ever moves or
      // deletes a lock that another taker has just created (roborev 7034).
      if (await reclaimStale(path, seen, alive)) continue;
      // Another taker is reclaiming: wait for it like any held lock, within the deadline.
    }
    if (Date.now() > deadline) {
      throw new CliError(EXIT.failure, `Another taskville start holds ${path}; try again shortly.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function writeRuntimeInfo(home: string, url: string, startedAt: Date): void {
  const info: RuntimeInfo = { url, pid: process.pid, startedAt: startedAt.toISOString() };
  const path = join(home, RUNTIME_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function removeRuntimeInfo(home: string): void {
  const path = join(home, RUNTIME_FILE);
  try {
    if ((JSON.parse(readFileSync(path, "utf8")) as RuntimeInfo).pid === process.pid) rmSync(path);
  } catch {
    // Absent or not ours: nothing to remove.
  }
}

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
export function composeServe(
  io: Io,
  home: string,
  portFlag: number | undefined,
  logging: LogRouting = { file: false, stderr: true },
): ServeParts {
  const now = io.now ?? (() => new Date());
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
    const logger = pino({ level: "info" }, logDestination(io, home, logging));
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
    // Optional OpenTelemetry receiver (M5.12): tokens and cost, kept in memory.
    registerOtlpRoutes(app, { logger });
    // Agent feed, crew, and evidence reads (M5.01): the stream cap and shutdown are the engine's.
    registerFeedRoutes(app, {
      storage: engine.storage,
      hub: engine.hub,
      pairing,
      evidence,
      now,
      queueLimit: engine.queueLimit,
      maxStreams: engine.maxStreams,
      drainTimeoutMs: engine.drainTimeoutMs,
    });
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

/**
 * The engine in the foreground, for `serve` and `start`. On a terminal (stdout is a TTY) the
 * console carries a short banner and plain sentences, and the JSON log lines go to
 * `<home>/logs/engine.log`; `--verbose` echoes them to stderr too. `start` always keeps the file.
 * `<home>/engine.json` is written once listening and removed on a clean stop; a live engine
 * recorded there is reported instead of starting a second one. `prepare` runs after that check
 * and before anything is created (`start` builds the web client there).
 */
export async function runEngine(
  context: Context,
  portFlag: number | undefined,
  mode: EngineMode,
  prepare?: () => Promise<void>,
): Promise<number> {
  const { io, home } = context;
  const release = await acquireLock(home);
  try {
    const running = await liveEngine(home);
    if (running !== undefined) {
      io.stdout(
        `Taskville is already running at ${running}\nFor a new pairing link, press p in that engine's terminal if it has one, or restart it.\n`,
      );
      release();
      return EXIT.ok;
    }
    await prepare?.();
  } catch (error) {
    release();
    throw error;
  }
  const now = io.now ?? (() => new Date());
  const quiet = io.stdoutIsTTY === true;
  const logging: LogRouting = {
    file: mode.command === "start" || quiet,
    stderr: !quiet || mode.verbose,
  };
  let wroteRuntime = false;
  let removePage: () => void = () => {};
  let parts: ServeParts | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let keys: { restore: () => void } | undefined;
  const stopDrain = new AbortController();
  let draining: Promise<unknown> = Promise.resolve();
  try {
    parts = composeServe(io, home, portFlag, logging);
    const { pairing, spool } = parts;
    // Spooled telemetry (M2.07), after the config projects so their roots route it: one bounded
    // run before listening, the rest worked off in bounded runs afterwards.
    const first = await replaySpool(spool);
    try {
      server = await startServer({ app: parts.app, port: parts.port });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      throw new CliError(
        EXIT.failure,
        `Port ${parts.port} is already in use by another program; pick a free one with --port.`,
      );
    }
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
    const linkText = (url: string) =>
      `Pair a browser (one-time link, valid for ${minutes} minutes): ${url}\n`;
    const printLink = () => io.stdout(linkText(`${base}/#pair=${pairing.issueCode()}`));
    writeRuntimeInfo(home, base, now());
    wroteRuntime = true;
    release();
    const firstLink = `${base}/#pair=${pairing.issueCode()}`;
    // The opener gets a 0600 redirect page, never the code: argv is visible to other local users.
    const page =
      mode.open && quiet && io.openUrl !== undefined
        ? writeRedirectPage(home, firstLink)
        : undefined;
    if (page !== undefined && io.openUrl !== undefined) {
      removePage = page.remove;
      await io.openUrl(pathToFileURL(page.path).href).then(
        () => {
          io.stdout("Opened your browser to pair it.\n");
          io.stdout(`If no browser opened, open this link:\n${firstLink}\n`);
          if (io.scheduleCleanup !== undefined)
            io.scheduleCleanup(page.remove, PAIRING_CODE_TTL_MS);
          else setTimeout(page.remove, REDIRECT_PAGE_TTL_MS).unref();
        },
        () => {
          page.remove();
          io.stdout(linkText(firstLink));
        },
      );
    } else {
      io.stdout(linkText(firstLink));
    }

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
      keys === undefined && mode.command === "serve" && !quiet
        ? "For a new pairing link later, restart taskville serve.\n"
        : keys === undefined
          ? `For a new pairing link later, restart taskville ${mode.command}. Ctrl-C stops the engine.\n`
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
    removeRuntimeInfo(home);
    release();
    removePage();
    io.stdout("Taskville engine stopped\n");
    return EXIT.ok;
  } catch (error) {
    // Never leave the terminal raw, whatever failed.
    release();
    keys?.restore();
    stopDrain.abort();
    await draining;
    await parts?.close();
    // A failure after listening (a closed terminal, say) must not leave the port open.
    await server?.close().catch(() => {});
    if (wroteRuntime) removeRuntimeInfo(home);
    removePage();
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT.failure, `Cannot start the engine: ${(error as Error).message}`);
  }
}

/** How long the redirect page lives when the caller schedules no cleanup. */
const REDIRECT_PAGE_TTL_MS = 30_000;

/**
 * Writes `<home>/run/<random>.html` (dir 0700, file 0600) that sends the browser to `url`, so the
 * one-time code never appears in the opener's argv. Returns undefined when it cannot be written.
 */
function writeRedirectPage(
  home: string,
  url: string,
): { path: string; remove: () => void } | undefined {
  const dir = join(home, "run");
  const path = join(dir, `${randomBytes(18).toString("base64url")}.html`);
  const attr = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const js = JSON.stringify(url).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Taskville</title>
<script>location.replace(${js});</script>
<noscript><meta http-equiv="refresh" content="0;url=${attr}"></noscript>
`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(path, html, { mode: 0o600, flag: "wx" });
  } catch {
    return undefined;
  }
  return { path, remove: () => rmSync(path, { force: true }) };
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
