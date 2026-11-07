import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUBBLE_TURN_MS, type Conversation } from "../../src/city/breaks/types.ts";
import { pickActivityLine, pickBanterLine } from "../../src/quips/banter.ts";

// M9.03: banter lines. Even turns the `a` agent speaks a headline, odd turns the `b` agent reacts.
// Seeded by (a, b, conversation start, turn): same conversation and turn, same line (replay equals
// live); turn t and t + 2 (same pool) never repeat.

const THEMES = ["default", "cyberpunk", "steampunk", "solarpunk", "aero"] as const;
const phrases = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../src/quips/phrases/${name}.json`, import.meta.url), "utf8"),
  ) as {
    banter: { headlines: string[]; reactions: string[] };
    activities: Record<string, string[]>;
  };

const START = 5_000_000;
const convo = (turn: number, over: Partial<Conversation> = {}): Conversation => ({
  a: "alpha",
  b: "bravo",
  siteId: "bar-1",
  turn,
  turnStartedAt: START + turn * BUBBLE_TURN_MS,
  ...over,
});

describe("pickBanterLine", () => {
  for (const theme of THEMES) {
    it(`${theme}: even turns are a's headline, odd turns are b's reaction`, () => {
      const p = phrases(theme);
      for (let turn = 0; turn < 8; turn++) {
        const out = pickBanterLine({ conversation: convo(turn), theme });
        if (turn % 2 === 0) {
          expect(out.speakerId).toBe("alpha");
          expect(p.banter.headlines).toContain(out.line);
        } else {
          expect(out.speakerId).toBe("bravo");
          expect(p.banter.reactions).toContain(out.line);
        }
      }
    });
  }

  it("is a pure function: same conversation and turn, same line, wherever in the turn", () => {
    const c = convo(3);
    const first = pickBanterLine({ conversation: c, theme: "aero" });
    expect(pickBanterLine({ conversation: { ...c }, theme: "aero" })).toEqual(first);
  });

  it("does not repeat a line on the next turn of the same speaker", () => {
    for (let i = 0; i < 30; i++) {
      const base = { a: `a${i}`, b: `b${i}` };
      for (let turn = 0; turn < 6; turn++) {
        const now = pickBanterLine({
          conversation: convo(turn, base),
          theme: "default",
        }).line;
        const next = pickBanterLine({
          conversation: convo(turn + 2, base),
          theme: "default",
        }).line;
        expect(next).not.toBe(now);
      }
    }
  });

  it("varies across pairs and conversation starts", () => {
    const lines = new Set<string>();
    for (let i = 0; i < 40; i++) {
      lines.add(
        pickBanterLine({
          conversation: convo(0, { a: `a${i}`, b: `b${i}`, turnStartedAt: START + i * 1000 }),
          theme: "default",
        }).line,
      );
    }
    expect(lines.size).toBeGreaterThan(2);
  });

  it("a different conversation start for the same pair can give a different line", () => {
    const lines = new Set<string>();
    for (let i = 0; i < 40; i++) {
      lines.add(
        pickBanterLine({
          conversation: convo(0, { turnStartedAt: START + i * 60_000 }),
          theme: "default",
        }).line,
      );
    }
    expect(lines.size).toBeGreaterThan(1);
  });

  it("falls back to the default voice for an unknown theme", () => {
    const out = pickBanterLine({ conversation: convo(0), theme: "no-such-theme" });
    expect(phrases("default").banter.headlines).toContain(out.line);
  });
});

describe("pickActivityLine", () => {
  const activities = ["bar", "smoke", "stroll", "juggle", "stargaze", "pigeons"] as const;

  for (const activity of activities) {
    it(`${activity}: comes from the theme's activity lines, seeded and stable`, () => {
      const input = { agentId: "alpha", activity, startedAt: START, theme: "steampunk" };
      const line = pickActivityLine(input);
      expect(phrases("steampunk").activities[activity]).toContain(line);
      expect(pickActivityLine({ ...input })).toBe(line);
    });
  }

  it("varies with agent id and break start", () => {
    const lines = new Set<string>();
    for (let i = 0; i < 40; i++) {
      lines.add(
        pickActivityLine({
          agentId: `agent-${i}`,
          activity: "bar",
          startedAt: START + i * 1000,
          theme: "default",
        }),
      );
    }
    expect(lines.size).toBeGreaterThan(1);
  });
});
