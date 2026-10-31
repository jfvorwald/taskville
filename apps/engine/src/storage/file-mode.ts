import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { StorageError } from "./errors.ts";

const OWNER_ONLY = 0o600;

/**
 * Makes sure `path` is a regular file (created if missing) readable and
 * writable by its owner only, and tightens it if it is not. Refuses symlinks
 * and non-regular files. `O_NONBLOCK` keeps a FIFO from blocking the open.
 */
function secureFile(path: string, create: boolean): void {
  const flags =
    constants.O_RDWR |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK |
    (create ? constants.O_CREAT : 0);
  let fd: number;
  try {
    fd = openSync(path, flags, OWNER_ONLY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!create && code === "ENOENT") return;
    throw new StorageError(`cannot open ${path} safely (${code ?? "unknown error"})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new StorageError(`${path} is not a regular file`);
    if ((stat.mode & 0o777) !== OWNER_ONLY) fchmodSync(fd, OWNER_ONLY);
  } finally {
    closeSync(fd);
  }
}

/**
 * Prepares the database file and any leftover WAL and SHM files before SQLite
 * opens them. SQLite creates new WAL and SHM files with the database file's
 * permissions, so an owner-only database keeps them owner-only too.
 */
export function secureDatabaseFiles(path: string): void {
  secureFile(path, true);
  secureFile(`${path}-wal`, false);
  secureFile(`${path}-shm`, false);
}
