// `pnpm release --out <dir> [--allow-dirty] [--environment <name>]`: the entry that fills in the
// real root for release.ts (M7.02).

import { fileURLToPath } from "node:url";
import { buildRelease } from "./release.ts";

const USAGE =
  "Usage: pnpm release --out <dir> [--allow-dirty] [--environment development|staging|production]";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function parse(
  args: string[],
): { outDir: string; allowDirty: boolean; environment?: string } | null {
  let outDir: string | undefined;
  let environment: string | undefined;
  let allowDirty = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--allow-dirty") allowDirty = true;
    else if (arg === "--out" || arg === "--environment") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return null;
      if (arg === "--out") outDir = value;
      else environment = value;
    } else return null;
  }
  if (outDir === undefined) return null;
  return { outDir, allowDirty, ...(environment === undefined ? {} : { environment }) };
}

const options = parse(process.argv.slice(2));
if (options === null) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  buildRelease({ root, ...options }).then(
    (release) => {
      console.log(`Release ${release.id} (${release.version}) written to ${release.directory}`);
    },
    (error: Error) => {
      console.error(`release: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
