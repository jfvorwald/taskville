import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the e2e engine writes the one-time pairing codes it issued at startup. */
export const CODES_FILE = join(
  fileURLToPath(new URL("../test-results", import.meta.url)),
  "pairing-codes.json",
);
