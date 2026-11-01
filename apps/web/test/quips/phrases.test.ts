import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// M4.06: phrase sets are plain data files, so adding lines or a new theme voice needs no code
// (ARCHITECTURE.md 2.3). One JSON file per theme id plus default.json, each mapping a level to
// an array of short lines.

const FILES = ["default", "cyberpunk", "steampunk", "solarpunk", "aero"] as const;
const LEVELS = ["needs_you", "trouble", "waiting"] as const;
const MAX_LINE = 48;

const load = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../src/quips/phrases/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;

describe("phrase data files", () => {
  for (const name of FILES) {
    describe(name, () => {
      for (const level of LEVELS) {
        it(`has at least three ${level} lines`, () => {
          const lines = load(name)[level];
          expect(Array.isArray(lines)).toBe(true);
          expect((lines as unknown[]).length).toBeGreaterThanOrEqual(3);
        });

        it(`keeps every ${level} line short, plain, and unique`, () => {
          const lines = load(name)[level] as string[];
          for (const line of lines) {
            expect(typeof line).toBe("string");
            expect(line.trim()).toBe(line);
            expect(line.length).toBeGreaterThan(0);
            expect(line.length).toBeLessThanOrEqual(MAX_LINE);
            // No em or en dashes (house style) and no markup or control characters.
            for (const ch of line) {
              const code = ch.codePointAt(0) ?? 0;
              expect(code).toBeGreaterThanOrEqual(0x20);
              expect(code === 0x2013 || code === 0x2014).toBe(false);
              expect("<>&").not.toContain(ch);
            }
          }
          expect(new Set(lines).size).toBe(lines.length);
        });
      }
    });
  }
});
