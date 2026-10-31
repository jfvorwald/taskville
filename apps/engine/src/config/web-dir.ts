import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where `pnpm --filter @taskville/web build` writes the client, relative to this repository. */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../../web/dist", import.meta.url));

export interface WebDir {
  /** The directory to serve, or undefined when no built client is there. */
  dir: string | undefined;
  /** The directory that was looked at and lacked an `index.html`. */
  missing?: string;
}

/**
 * The built web client to host: `$TASKVILLE_WEB_DIR` when set, else `apps/web/dist`. A directory
 * without an `index.html` counts as not built, so the engine never serves an empty folder.
 */
export function resolveWebDir(env: Record<string, string | undefined> = process.env): WebDir {
  const override = env.TASKVILLE_WEB_DIR;
  const dir = override === undefined || override === "" ? DEFAULT_WEB_DIR : resolve(override);
  return existsSync(join(dir, "index.html")) ? { dir } : { dir: undefined, missing: dir };
}
