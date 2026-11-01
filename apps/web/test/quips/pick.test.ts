import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { pickQuip } from "../../src/quips/pick.ts";

// M4.06: the line in a bubble is a pure function of (agent ID, event ID, level, theme)
// (ARCHITECTURE.md 2.3 and 3), so replay shows the same quips as live. Lines come only from the
// plain phrase data in src/quips/phrases/<theme>.json (aero, cyberpunk, solarpunk, steampunk) and
// the default voice in default.json. Each file maps a level to an array of lines.

type Level = "needs_you" | "trouble" | "waiting";
type Phrases = Record<Level, string[]>;

const phrases = (name: string): Phrases =>
  JSON.parse(
    readFileSync(new URL(`../../src/quips/phrases/${name}.json`, import.meta.url), "utf8"),
  ) as Phrases;

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `evt-${i}`);

describe("pickQuip determinism", () => {
  it("gives the same line for the same inputs across calls", () => {
    const input = {
      agentId: "agent-1",
      eventId: "evt-9",
      level: "needs_you",
      theme: "steampunk",
    } as const;
    const first = pickQuip(input);
    for (let i = 0; i < 20; i++) expect(pickQuip({ ...input })).toBe(first);
  });

  it("gives the same line after the module is reloaded", async () => {
    const input = {
      agentId: "agent-7",
      eventId: "evt-31",
      level: "trouble",
      theme: "cyberpunk",
    } as const;
    const before = pickQuip(input);
    vi.resetModules();
    const reloaded = await import("../../src/quips/pick.ts");
    expect(reloaded.pickQuip(input)).toBe(before);
  });

  it("does not read the clock or a random source", () => {
    const now = vi.spyOn(Date, "now");
    const random = vi.spyOn(Math, "random");
    pickQuip({ agentId: "a", eventId: "e", level: "waiting", theme: "aero" });
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    now.mockRestore();
    random.mockRestore();
  });

  it("spreads different event IDs across every line of the set", () => {
    const lines = phrases("cyberpunk").needs_you;
    const seen = new Set(
      ids(400).map((eventId) =>
        pickQuip({ agentId: "agent-1", eventId, level: "needs_you", theme: "cyberpunk" }),
      ),
    );
    expect(seen).toEqual(new Set(lines));
  });

  it("depends on the agent ID as well as the event ID", () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_, i) =>
        pickQuip({ agentId: `agent-${i}`, eventId: "evt-1", level: "needs_you", theme: "aero" }),
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("pickQuip phrase data", () => {
  const themes = ["cyberpunk", "steampunk", "solarpunk", "aero"] as const;
  const levels: Level[] = ["needs_you", "trouble", "waiting"];

  for (const theme of themes) {
    for (const level of levels) {
      it(`${theme} ${level} lines come only from ${theme}.json`, () => {
        const allowed = new Set(phrases(theme)[level]);
        for (const eventId of ids(60)) {
          expect(allowed).toContain(pickQuip({ agentId: "agent-2", eventId, level, theme }));
        }
      });
    }
  }

  it("falls back to the default voice for a theme with no phrase data", () => {
    const allowed = new Set(phrases("default").needs_you);
    for (const eventId of ids(60)) {
      expect(allowed).toContain(
        pickQuip({ agentId: "agent-2", eventId, level: "needs_you", theme: "no-such-theme" }),
      );
    }
  });

  it("returns a non-empty string for every level in the default voice", () => {
    for (const level of levels) {
      const line = pickQuip({ agentId: "a", eventId: "e", level, theme: "no-such-theme" });
      expect(line.trim().length).toBeGreaterThan(0);
    }
  });
});
