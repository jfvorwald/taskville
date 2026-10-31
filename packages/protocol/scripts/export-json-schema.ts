// Writes the protocol's JSON Schema documents for adapter authors.
// Usage: pnpm --filter @taskville/protocol run export-json-schema <output-dir>

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildJsonSchemas } from "../src/index.ts";

/** Writes one `<name>.schema.json` per document into `outDir` and returns the written paths. */
export function exportJsonSchemas(outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  return Object.entries(buildJsonSchemas()).map(([name, schema]) => {
    const path = join(outDir, `${name}.schema.json`);
    writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`);
    return path;
  });
}

if (import.meta.main) {
  const target = process.argv[2];
  if (target === undefined) {
    console.error("Usage: export-json-schema <output-dir>");
    process.exit(2);
  }
  const outDir = resolve(target);
  const written = exportJsonSchemas(outDir);
  console.log(`Wrote ${written.length} schemas to ${outDir}`);
}
