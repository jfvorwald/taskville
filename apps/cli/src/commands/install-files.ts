import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CliError, EXIT } from "../errors.ts";

// File handling for `taskville install claude-code` (#29): reading settings without following
// surprises, atomic writes that keep the file's mode, the backup kept for uninstall, and the shim
// copy in the Taskville home.

const fail = (message: string): never => {
  throw new CliError(EXIT.failure, message);
};

const lstatOrUndefined = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export interface SettingsTarget {
  /** The path shown to the user (a symlink's own path when one was followed). */
  shown: string;
  /** The regular file actually read and written. */
  path: string;
}

/**
 * User scope: `<CLAUDE_CONFIG_DIR or $HOME/.claude>/settings.json`. A symlinked file (dotfiles) is
 * followed, and its target is written in place so the link survives (decision #190 D2).
 */
export function userSettingsTarget(configDir: string): SettingsTarget {
  const shown = join(configDir, "settings.json");
  const stat = lstatOrUndefined(shown);
  if (stat?.isSymbolicLink()) {
    let path: string;
    try {
      path = realpathSync(shown);
    } catch {
      return fail(`settings file ${shown} is a symlink to a missing file; create the target first`);
    }
    return { shown, path };
  }
  return { shown, path: shown };
}

/**
 * Project scope: `<project>/.claude/settings.local.json` (decision #190 D1). A symlinked `.claude`
 * or settings file is refused: a cloned repository could aim it at another file (D2).
 */
export function projectSettingsTarget(projectDir: string): SettingsTarget {
  const project = lstatOrUndefined(projectDir);
  if (project === undefined || (!project.isDirectory() && !project.isSymbolicLink())) {
    fail(`project directory ${projectDir} does not exist`);
  }
  const dir = join(projectDir, ".claude");
  if (lstatOrUndefined(dir)?.isSymbolicLink())
    fail(`${dir} is a symlink; refusing to write through it`);
  const path = join(dir, "settings.local.json");
  if (lstatOrUndefined(path)?.isSymbolicLink())
    fail(`${path} is a symlink; refusing to write through it`);
  return { shown: path, path };
}

export interface FileState {
  /** File contents, or undefined when the file does not exist. */
  text: string | undefined;
  mode: number | undefined;
}

/** Reads a regular file without blocking on a FIFO; undefined text when it does not exist. */
export function readState(path: string): FileState {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { text: undefined, mode: undefined };
    if (code === "ELOOP") return fail(`${path} is a symlink; refusing to read through it`);
    return fail(`cannot read ${path} (${(error as Error).message})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail(`${path} is not a regular file`);
    return { text: readFileSync(fd, "utf8"), mode: stat.mode & 0o7777 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `text` to `path` atomically: a new file in the same directory, flushed, then renamed
 * over the old one. `mode` is the old file's (0600 for a new file).
 */
export function writeAtomic(path: string, text: string, mode: number | undefined): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${basename(path)}.taskville-${randomUUID()}.tmp`);
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, text);
    // fchmod after creation so the umask cannot narrow or widen the kept mode.
    fchmodSync(fd, mode ?? 0o600);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temp, path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Removes `path` if it is a regular file (never follows a symlink). */
export function removeFile(path: string): void {
  const stat = lstatOrUndefined(path);
  if (stat === undefined) return;
  if (!stat.isFile()) fail(`${path} is not a regular file; not removing it`);
  rmSync(path);
}

/** The backup of the settings file as it was before the first install, kept next to it. */
export const backupPath = (settingsPath: string) => `${settingsPath}.taskville-backup`;

/**
 * Creates the backup if there is none. An empty backup means "the file did not exist": install
 * refuses an empty settings file (not valid JSON), so a real original is never empty.
 */
export function writeBackupOnce(settingsPath: string, original: FileState): void {
  const path = backupPath(settingsPath);
  if (lstatOrUndefined(path) !== undefined) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    writeSync(fd, original.text ?? "");
    fsyncSync(fd);
    fchmodSync(fd, original.mode ?? 0o600);
  } finally {
    closeSync(fd);
  }
}

/** The backup's contents, or undefined when there is none (or it is not a regular file). */
export function readBackup(settingsPath: string): string | undefined {
  const path = backupPath(settingsPath);
  const stat = lstatOrUndefined(path);
  if (stat === undefined || !stat.isFile()) return undefined;
  return readState(path).text;
}

/** A private directory: created 0700 if missing; a symlink or non-directory is refused. */
function privateDir(path: string, create: boolean): void {
  const stat = lstatOrUndefined(path);
  if (stat === undefined) {
    if (!create) return;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return;
  }
  if (stat.isSymbolicLink()) fail(`${path} is a symlink; refusing to use it`);
  if (!stat.isDirectory()) fail(`${path} is not a directory`);
}

/**
 * Checks, without writing, that the shim can be installed at `<home>/hooks/<name>`, and reports
 * whether its contents would change.
 */
export function checkShim(
  home: string,
  name: string,
  source: string,
): { path: string; changes: boolean } {
  privateDir(home, false);
  const hooks = join(home, "hooks");
  privateDir(hooks, false);
  const path = join(hooks, name);
  const stat = lstatOrUndefined(path);
  if (stat?.isSymbolicLink()) fail(`${path} is a symlink; refusing to replace it`);
  if (stat !== undefined && !stat.isFile()) fail(`${path} is not a regular file`);
  const current = stat === undefined ? undefined : readState(path);
  const changes = current?.text !== source || current.mode !== 0o755;
  return { path, changes };
}

/** Copies the shim into `<home>/hooks` (0700) as a 0755 file, atomically. */
export function installShim(home: string, name: string, source: string): string {
  privateDir(home, true);
  const hooks = join(home, "hooks");
  privateDir(hooks, true);
  const { path } = checkShim(home, name, source);
  writeAtomic(path, source, 0o755);
  return path;
}
