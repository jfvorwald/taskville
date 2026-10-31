import { closeSync, constants, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { generateSecret } from "./secrets.ts";

/** Raised when a token file exists but cannot be trusted. Never carries the token value. */
export class TokenFileError extends Error {
  override name = "TokenFileError";
}

const MIN_TOKEN_LENGTH = 32;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Returns the token stored at `path`, creating the file with a new random
 * token and mode 0600 if it does not exist. The parent directory must exist
 * (it is the Taskville home, owned by the config module).
 *
 * An existing file is refused if it is a symlink, not a regular file, owned by
 * another user, readable or writable by group or others, or does not hold a
 * plausible token. The caller decides how to report that; the file is never
 * silently rewritten, because the bridge token may be referenced elsewhere.
 */
export function loadOrCreateToken(path: string): string {
  const created = tryCreate(path);
  return created ?? readExisting(path);
}

function tryCreate(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if (isErrno(err, "EEXIST")) return undefined;
    throw err;
  }
  const token = generateSecret();
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  return token;
}

function readExisting(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    if (isErrno(err, "ELOOP")) throw new TokenFileError(`token file ${path} is a symlink`);
    throw err;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new TokenFileError(`token file ${path} is not a regular file`);
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      throw new TokenFileError(`token file ${path} is owned by another user`);
    }
    if ((stats.mode & 0o077) !== 0) {
      const mode = (stats.mode & 0o777).toString(8).padStart(3, "0");
      throw new TokenFileError(`token file ${path} has mode ${mode}; run: chmod 600 ${path}`);
    }
    const token = readFileSync(fd, "utf8").trim();
    if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) {
      throw new TokenFileError(`token file ${path} does not hold a valid token`);
    }
    return token;
  } finally {
    closeSync(fd);
  }
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}
