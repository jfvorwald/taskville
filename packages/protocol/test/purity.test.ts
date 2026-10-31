import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The web client reuses this package (ARCHITECTURE.md section 5), so src/ must import no Node
// built-in, with or without the `node:` prefix.
const srcDir = join(import.meta.dirname, "..", "src");
const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(c|m)?[jt]sx?$/.test(entry.name) ? [path] : [];
  });

const SPECIFIER = /(?:\bimport\s*\(\s*|\brequire\s*\(\s*|\bfrom\s+|\bimport\s+)["']([^"']+)["']/g;

function forbiddenImports(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? "";
    const root = specifier.split("/")[0] ?? "";
    if (specifier.startsWith("node:") || builtins.has(specifier) || builtins.has(root)) {
      found.push(specifier);
    }
  }
  return found;
}

describe("no Node built-ins in src", () => {
  it("detects each import form it guards against", () => {
    expect(forbiddenImports('import { readFileSync } from "node:fs";')).toEqual(["node:fs"]);
    expect(forbiddenImports("import path from 'path';")).toEqual(["path"]);
    expect(forbiddenImports('import "crypto";')).toEqual(["crypto"]);
    expect(forbiddenImports('export * from "fs/promises";')).toEqual(["fs/promises"]);
    expect(forbiddenImports('await import("node:sqlite")')).toEqual(["node:sqlite"]);
    expect(forbiddenImports('const x = require("os")')).toEqual(["os"]);
    expect(forbiddenImports('import { z } from "zod";')).toEqual([]);
    expect(forbiddenImports('import { a } from "./enums.ts";')).toEqual([]);
  });

  it("finds source files to scan", () => {
    expect(sourceFiles(srcDir).length).toBeGreaterThan(0);
  });

  it("has no file under src importing a Node built-in", () => {
    const offenders = sourceFiles(srcDir).flatMap((file) =>
      forbiddenImports(readFileSync(file, "utf8")).map(
        (spec) => `${relative(srcDir, file)}: ${spec}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
