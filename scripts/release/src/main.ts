// `pnpm release --out <dir> [--allow-dirty]`: the entry that fills in the real root for release.ts (M7.02).

import { fileURLToPath } from "node:url";
import { buildRelease } from "./release.ts";

const USAGE = "Usage: pnpm release --out <dir> [--allow-dirty]";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf("--out");
const outDir = at === -1 ? undefined : args[at + 1];
const unknown = args.filter(
  (arg, i) => arg !== "--allow-dirty" && arg !== "--out" && args[i - 1] !== "--out",
);

if (outDir === undefined || outDir.startsWith("--") || unknown.length > 0) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  buildRelease({ root, outDir, allowDirty: args.includes("--allow-dirty") }).then(
    (release) => {
      console.log(`Release ${release.id} (${release.version}) written to ${release.directory}`);
    },
    (error: Error) => {
      console.error(`release: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
