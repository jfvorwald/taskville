import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join, resolve } from "node:path";
import { loadOrCreateToken } from "../auth/token-file.ts";

/** Raised when the Taskville home cannot be used safely. */
export class HomeError extends Error {
  override name = "HomeError";
}

export interface HomePaths {
  home: string;
  /** Optional user-edited settings (see config.ts). */
  config: string;
  /** CLI and telemetry-shim token, mode 0600. */
  token: string;
  /** Permission-bridge token, mode 0600. Separate so neither can stand in for the other. */
  bridgeToken: string;
  /** Event log and projections (storage module). */
  db: string;
  /** Evidence bodies (M2.06). */
  evidenceDb: string;
  /** Telemetry shim spool, ingested on the next engine start. */
  spoolDir: string;
}

export interface ResolveHomeOptions {
  /** The `--home` flag, if given. */
  flag?: string | undefined;
  env?: Record<string, string | undefined>;
  homedir?: string;
  cwd?: string;
}

/** `--home`, else `$TASKVILLE_HOME`, else `~/.taskville`; always an absolute path. */
export function resolveHome(options: ResolveHomeOptions = {}): string {
  const homedir = options.homedir ?? osHomedir();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const raw = nonEmpty(options.flag) ?? nonEmpty(env.TASKVILLE_HOME) ?? join(homedir, ".taskville");
  return resolve(cwd, expandTilde(raw, homedir));
}

export function homePaths(home: string): HomePaths {
  return {
    home,
    config: join(home, "config.json"),
    token: join(home, "token"),
    bridgeToken: join(home, "bridge-token"),
    db: join(home, "taskville.db"),
    evidenceDb: join(home, "evidence.db"),
    spoolDir: join(home, "spool"),
  };
}

export interface PreparedHome {
  paths: HomePaths;
  cliToken: string;
  bridgeToken: string;
}

/**
 * Creates the home and spool directories (mode 0700, tightened if they
 * already exist with other modes) and both token files (mode 0600, via the
 * auth module), and returns the paths and tokens. Safe to call on every start.
 */
export function ensureHome(home: string): PreparedHome {
  const paths = homePaths(home);
  ensurePrivateDir(paths.home);
  ensurePrivateDir(paths.spoolDir);
  const cliToken = loadOrCreateToken(paths.token);
  const bridgeToken = loadOrCreateToken(paths.bridgeToken);
  if (cliToken === bridgeToken) {
    throw new HomeError(
      `${paths.token} and ${paths.bridgeToken} hold the same token; delete ${paths.bridgeToken} so a new one is created`,
    );
  }
  return { paths, cliToken, bridgeToken };
}

function ensurePrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new HomeError(`cannot create directory ${dir}: ${(err as Error).message}`);
  }
  const stats = statSync(dir);
  if (!stats.isDirectory()) throw new HomeError(`${dir} exists but is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new HomeError(`${dir} is owned by another user`);
  }
  if ((stats.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** Expands a leading `~` or `~/`. Other `~user` forms are left alone. */
export function expandTilde(path: string, homedir: string): string {
  if (path === "~") return homedir;
  if (path.startsWith("~/")) return join(homedir, path.slice(2));
  return path;
}
