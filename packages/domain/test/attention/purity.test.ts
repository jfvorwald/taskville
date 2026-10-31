import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The requests reducer and the selectors must never read the clock or randomness (constitution
// III, .roborev.toml invariant 3): time comes from events, and elapsed-time rules take `now` as an
// argument. `Date.parse` of an event timestamp is allowed; it reads no clock.

const SRC = join(import.meta.dirname, "../../src");
const DIRS = ["reducer/attention", "selectors"].map((d) => join(SRC, d));

const FORBIDDEN = [
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(/,
  /(?<![\w.])Date\s*\(/,
  /\bMath\.random\s*\(/,
  /\bperformance\s*\./,
  /\bcrypto\s*\./,
  /\bprocess\s*\./,
];

const offenses = (source: string): string[] =>
  FORBIDDEN.filter((pattern) => pattern.test(source)).map(String);

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));

describe("requests reducer and selectors read no clock or randomness", () => {
  it("detects each forbidden form and allows Date.parse", () => {
    for (const bad of [
      "Date.now()",
      "new Date()",
      "const d = Date();",
      "Math.random()",
      "performance.now()",
      "crypto.randomUUID()",
      "process.hrtime()",
    ]) {
      expect(offenses(bad), bad).not.toEqual([]);
    }
    expect(offenses("Date.parse(event.occurredAt)")).toEqual([]);
  });

  it("finds files in every scanned directory", () => {
    for (const dir of DIRS) expect(files(dir).length, dir).toBeGreaterThan(0);
  });

  it("has no clock or randomness under reducer/attention and selectors", () => {
    const found = DIRS.flatMap(files).flatMap((file) =>
      offenses(readFileSync(file, "utf8")).map((o) => `${relative(SRC, file)}: ${o}`),
    );
    expect(found).toEqual([]);
  });
});
