import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

/** What `/health` reports about the running build. No commit, no paths. */
export interface ReleaseIdentity {
  id: string;
  version: string;
  environment: "development" | "staging" | "production";
}

export const RELEASE_FILE = "release.json";

const ReleaseFile = z.object({
  id: z.string().min(1),
  version: z.string().optional(),
  environment: z.enum(["development", "staging", "production"]),
});

/** The identity of a checkout with no `release.json`. */
export function devRelease(version: string): ReleaseIdentity {
  return { id: "dev", version, environment: "development" };
}

/**
 * Reads the optional `release.json` in `dir` (next to the engine's entry point). A missing file
 * is a dev checkout. A file that cannot be read or does not fit the shape falls back to the dev
 * identity with a warning; it never fails boot.
 */
export function loadRelease(options: {
  dir: string;
  version: string;
  logger?: Logger;
}): ReleaseIdentity {
  const { dir, version, logger } = options;
  let text: string;
  try {
    text = readFileSync(join(dir, RELEASE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger?.warn(
        { errName: (error as Error).name },
        "release.json unreadable; using the dev release identity",
      );
    }
    return devRelease(version);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    logger?.warn("release.json is not valid JSON; using the dev release identity");
    return devRelease(version);
  }
  const parsed = ReleaseFile.safeParse(body);
  if (!parsed.success) {
    logger?.warn("release.json has the wrong shape; using the dev release identity");
    return devRelease(version);
  }
  const { id, environment } = parsed.data;
  return { id, version: parsed.data.version ?? version, environment };
}
