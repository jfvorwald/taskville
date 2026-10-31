import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// packages/domain must stay pure and browser-safe (constitution III, ARCHITECTURE.md).
// This scans every source file and fails on any import of a Node built-in, whether
// written as "node:fs" or as a bare "fs". Tests may use built-ins; src may not.

const SRC = join(import.meta.dirname, "../src");

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g, // import x from "m"; export { x } from "m"
  /\bimport\s*["']([^"']+)["']/g, // import "m"
  /\bimport\s*\(\s*["']([^"']+)["']/g, // import("m")
  /\brequire\s*\(\s*["']([^"']+)["']/g, // require("m")
];

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

function builtinImports(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1] ?? "";
      const bare = spec.replace(/^node:/, "");
      if (spec.startsWith("node:") || BUILTINS.has(bare) || BUILTINS.has(bare.split("/")[0] ?? "")) {
        found.push(spec);
      }
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

describe("packages/domain imports no Node built-ins", () => {
  it("detects every import form, prefixed or bare", () => {
    const sample = [
      'import { readFileSync } from "node:fs";',
      "import path from 'path';",
      'export { x } from "fs/promises";',
      'import "node:process";',
      'const c = await import("crypto");',
      'const u = require("util");',
      'import { a } from "./local.ts";',
      'import fc from "fast-check";',
    ].join("\n");
    expect(builtinImports(sample).sort()).toEqual(
      ["crypto", "fs/promises", "node:fs", "node:process", "path", "util"].sort(),
    );
  });

  it("finds source files to scan", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(0);
  });

  it("has no built-in imports under src/", () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      builtinImports(readFileSync(file, "utf8")).map((spec) => `${relative(SRC, file)}: ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});
