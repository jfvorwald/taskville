import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// packages/demo must stay pure and browser-safe (constitution III): the scenario is seeded and runs
// on a virtual clock, so the same seed and pace always give the same events. Copied from
// packages/domain/test/purity.test.ts.
// Two scans over every source file: no import of a Node built-in (written as "node:fs" or as a
// bare "fs"), and no use of the clock, randomness, or host globals. Tests may use all of these;
// src may not. The second scan is a tripwire on identifiers, not a proof: it ignores comments
// and quoted strings, and it would miss an alias smuggled in through an allowed import.

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
      if (
        spec.startsWith("node:") ||
        BUILTINS.has(bare) ||
        BUILTINS.has(bare.split("/")[0] ?? "")
      ) {
        found.push(spec);
      }
    }
  }
  return found;
}

// Each entry names a global the demo must not touch. Any use counts, not only a call, so
// `const now = Date.now` is caught too. `Date` is banned except `Date.parse` and `Date.UTC`,
// which read no clock (M1.08's selectors parse event timestamps). The entities reducer
// compares timestamps by hand instead (reducer/entities/time.ts), because Date.parse is only
// specified to millisecond precision and protocol timestamps may carry more digits.
const FORBIDDEN_GLOBALS: [RegExp, string][] = [
  [/\bDate\b(?!\s*\.\s*(?:parse|UTC)\b)/, "Date (clock)"],
  [/\bperformance\b/, "performance (clock)"],
  [/\bMath\s*\.\s*random\b/, "Math.random (randomness)"],
  [/\bcrypto\b/, "crypto (randomness or host API)"],
  [/\b(?:process|Buffer|require|module|__dirname|__filename)\b/, "Node global"],
  [
    /\b(?:globalThis|window|self|document|navigator|localStorage|sessionStorage|indexedDB)\b/,
    "host global",
  ],
  [
    /\b(?:setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|queueMicrotask|requestAnimationFrame)\b/,
    "timer",
  ],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/, "network"],
  [/\b(?:TextEncoder|TextDecoder|structuredClone)\b/, "host API"],
  [/\bconsole\b/, "console (I/O)"],
  [/\bimport\s*\.\s*meta\b/, "import.meta"],
];

/** Blanks out comments and single- or double-quoted strings, keeping line structure. */
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'") {
      out += " ";
      i++;
      while (i < source.length && source[i] !== c && source[i] !== "\n") {
        if (source[i] === "\\") i++;
        i++;
      }
      out += " ";
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function forbiddenUses(source: string): string[] {
  const found: string[] = [];
  for (const [n, line] of codeOnly(source).split("\n").entries()) {
    for (const [pattern, label] of FORBIDDEN_GLOBALS) {
      if (pattern.test(line)) found.push(`line ${n + 1}: ${label}`);
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

describe("packages/demo imports no Node built-ins", () => {
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

describe("packages/demo reads no clock, randomness, or host globals", () => {
  it("detects forbidden uses in code but not in comments or strings", () => {
    const sample = [
      "const t = Date.now();",
      "const d = new Date();",
      "const p = performance.now();",
      "const r = Math.random();",
      "crypto.getRandomValues(buf);",
      "const id = crypto.randomUUID();",
      "if (process.env.X) {}",
      "globalThis.fetch(u);",
      "setTimeout(f, 1);",
      "const now = Date;",
      "// Date.now() in a comment is fine",
      "/* Math.random() */ const x = 1;",
      'const s = "process and Date in a string";',
      "const ok = { updatedAt: event.occurredAt };",
      "const ms = Date.parse(event.occurredAt) + Date.UTC(2026, 0, 1);",
      "const d2 = Date.parse(x) + Date.now();",
    ].join("\n");
    expect(forbiddenUses(sample)).toEqual([
      "line 1: Date (clock)",
      "line 2: Date (clock)",
      "line 3: performance (clock)",
      "line 4: Math.random (randomness)",
      "line 5: crypto (randomness or host API)",
      "line 6: crypto (randomness or host API)",
      "line 7: Node global",
      "line 8: host global",
      "line 8: network",
      "line 9: timer",
      "line 10: Date (clock)",
      "line 16: Date (clock)",
    ]);
  });

  it("has no forbidden uses under src/", () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      forbiddenUses(readFileSync(file, "utf8")).map((use) => `${relative(SRC, file)} ${use}`),
    );
    expect(offenders).toEqual([]);
  });
});
