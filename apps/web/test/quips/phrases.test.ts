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

const ACTIVITIES = ["bar", "smoke", "stroll", "juggle", "stargaze", "pigeons"] as const;

// M9.03: banter (headlines and reactions) and per-activity lines, same character rules.
function expectPlainLines(lines: unknown, min: number): void {
  expect(Array.isArray(lines)).toBe(true);
  const list = lines as string[];
  expect(list.length).toBeGreaterThanOrEqual(min);
  for (const line of list) {
    expect(typeof line).toBe("string");
    expect(line.trim()).toBe(line);
    expect(line.length).toBeGreaterThan(0);
    expect(line.length).toBeLessThanOrEqual(MAX_LINE);
    for (const ch of line) {
      const code = ch.codePointAt(0) ?? 0;
      expect(code).toBeGreaterThanOrEqual(0x20);
      expect(code === 0x2013 || code === 0x2014).toBe(false);
      expect("<>&").not.toContain(ch);
    }
  }
  expect(new Set(list).size).toBe(list.length);
}

describe("banter and activity phrases", () => {
  for (const name of FILES) {
    describe(name, () => {
      it("has only the known top-level keys", () => {
        expect(Object.keys(load(name)).sort()).toEqual([...LEVELS, "banter", "activities"].sort());
      });
      it("has at least six plain headlines", () => {
        const banter = load(name).banter as Record<string, unknown>;
        expectPlainLines(banter?.headlines, 6);
      });
      it("has at least six plain reactions", () => {
        const banter = load(name).banter as Record<string, unknown>;
        expectPlainLines(banter?.reactions, 6);
      });
      it("keeps headlines and reactions apart", () => {
        const banter = load(name).banter as { headlines: string[]; reactions: string[] };
        const heads = new Set(banter.headlines);
        expect(banter.reactions.filter((r) => heads.has(r))).toEqual([]);
      });
      for (const activity of ACTIVITIES) {
        it(`has at least two plain ${activity} lines`, () => {
          const activities = load(name).activities as Record<string, unknown>;
          expectPlainLines(activities?.[activity], 2);
        });
      }
      it("has no other activity keys", () => {
        const activities = load(name).activities as Record<string, unknown>;
        expect(Object.keys(activities ?? {}).sort()).toEqual([...ACTIVITIES].sort());
      });
    });
  }
});

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
