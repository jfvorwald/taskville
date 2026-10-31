import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Invariant 3 (.roborev.toml, constitution III): packages/adapters is pure. It imports
// no Node built-ins and never reads the clock or randomness. Nothing else enforces this
// yet, so this test scans every source file in the package.

const SRC = join(import.meta.dirname, "..", "src");

const BUILTINS = new Set(builtinModules);

// Module specifiers in static imports, re-exports, side-effect imports, dynamic
// imports, and require calls.
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

// Ambient sources of time, randomness, or process state.
const IMPURE_GLOBALS = [
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(/,
  /\bMath\.random\s*\(/,
  /\bperformance\.now\s*\(/,
  /\bcrypto\.(?:getRandomValues|randomUUID)\b/,
  /\bprocess\./,
];

export function impurities(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1] ?? "";
      if (spec.startsWith("node:") || BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0] ?? "")) {
        found.push(`imports built-in "${spec}"`);
      }
    }
  }
  for (const pattern of IMPURE_GLOBALS) {
    const match = source.match(pattern);
    if (match) found.push(`uses ${match[0]}`);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

describe("purity scanner", () => {
  it.each([
    ['import { readFileSync } from "node:fs";', 'imports built-in "node:fs"'],
    ["import fs from 'fs';", 'imports built-in "fs"'],
    ['import { readFile } from "fs/promises";', 'imports built-in "fs/promises"'],
    ['export * from "node:path";', 'imports built-in "node:path"'],
    ['import "node:process";', 'imports built-in "node:process"'],
    ['const m = await import("crypto");', 'imports built-in "crypto"'],
    ['const os = require("os");', 'imports built-in "os"'],
    ["const t = Date.now();", "uses Date.now("],
    ["const d = new Date();", "uses new Date("],
    ["const r = Math.random();", "uses Math.random("],
    ["const id = crypto.randomUUID();", "uses crypto.randomUUID"],
    ["const home = process.env.HOME;", "uses process."],
  ])("flags %s", (source, expected) => {
    expect(impurities(source)).toContain(expected);
  });

  it.each([
    'import { x } from "./local.ts";',
    'import { describe } from "vitest";',
    'import type { Event } from "@taskville/protocol";',
    'const s = "a path like /usr/lib/fs is just text";',
  ])("allows %s", (source) => {
    expect(impurities(source)).toEqual([]);
  });
});

describe("packages/adapters/src", () => {
  const files = sourceFiles(SRC);

  it("has source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("imports no Node built-ins and reads no clock, randomness, or process state", () => {
    const report = files.flatMap((file) =>
      impurities(readFileSync(file, "utf8")).map((issue) => `${relative(SRC, file)}: ${issue}`),
    );
    expect(report).toEqual([]);
  });
});
