import { fileURLToPath } from "node:url";

/**
 * The CLI package root: one level above the directory holding this module. That is `apps/cli` in
 * a checkout and the package root in the flat release bundle (`bin/taskville.js`), where every
 * module shares one directory. Keep this module directly under `src`, so the two layouts agree.
 */
export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
