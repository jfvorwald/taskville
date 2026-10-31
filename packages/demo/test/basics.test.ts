import { describe, expect, it } from "vitest";
import {
  CALM,
  formatPace,
  isoFromMs,
  LIVELY,
  MAX_DURATION_MS,
  mulberry32,
  parseDuration,
  parsePace,
  type Rng,
  seededRng,
} from "../src/index.ts";

describe("mulberry32", () => {
  it("matches the reference sequence", () => {
    // Reference values computed independently from the published algorithm.
    const one = mulberry32(1);
    expect([one(), one(), one()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    ]);
    const answer = mulberry32(42);
    expect([answer(), answer(), answer()]).toEqual([
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099,
    ]);
  });

  it("stays in [0, 1) and treats seeds as uint32", () => {
    const next = mulberry32(7);
    for (let i = 0; i < 10_000; i++) {
      const x = next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(2 ** 32 + 5)()).toBe(mulberry32(5)());
    expect(mulberry32(-1)()).toBe(mulberry32(2 ** 32 - 1)());
  });
});

describe("seededRng", () => {
  const rng: Rng = seededRng(42);

  it("draws inclusive integers, picks, and hex", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(rng.int(3, 6));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    expect(["a", "b"]).toContain(rng.pick(["a", "b"]));
    expect(rng.hex(40)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is reproducible per seed", () => {
    const a = seededRng(9);
    const b = seededRng(9);
    expect([a.int(0, 1e6), a.hex(8), a.chance(0.5)]).toEqual([
      b.int(0, 1e6),
      b.hex(8),
      b.chance(0.5),
    ]);
  });

  it("rejects an empty pick and a reversed range", () => {
    expect(() => rng.pick([])).toThrow();
    expect(() => rng.int(5, 4)).toThrow();
  });
});

describe("pace (FR-013, contracts/cli.md)", () => {
  it("has the calm and lively presets", () => {
    expect(parsePace("calm")).toEqual(CALM);
    expect(CALM).toMatchObject({ changeMinMs: 5_000, changeMaxMs: 15_000, needsYouMs: 180_000 });
    expect(parsePace("lively")).toEqual(LIVELY);
    expect(LIVELY).toMatchObject({ changeMinMs: 1_000, changeMaxMs: 3_000 });
    expect(LIVELY.needsYouMs).toBeLessThanOrEqual(CALM.needsYouMs);
  });

  it("parses custom intervals", () => {
    expect(parsePace("change=2s-6s,needs-you=90s")).toEqual({
      name: "change=2s-6s,needs-you=90s",
      changeMinMs: 2_000,
      changeMaxMs: 6_000,
      needsYouMs: 90_000,
    });
    expect(parsePace("needs-you=1m, change=1.5s-2s")).toMatchObject({
      changeMinMs: 1_500,
      changeMaxMs: 2_000,
      needsYouMs: 60_000,
    });
  });

  it.each([
    "",
    "brisk",
    "change=2s-6s",
    "needs-you=90s",
    "change=6s-2s,needs-you=90s",
    "change=0s-2s,needs-you=90s",
    "change=2-6,needs-you=90s",
    "change=2s-6s,needs-you=0s",
    "change=2s-6s,needs-you=90s,extra=1s",
    "change=2s-6s,change=3s-4s,needs-you=90s",
    `change=1s-${"9".repeat(400)}s,needs-you=90s`,
    `change=${"9".repeat(400)}s-${"9".repeat(401)}s,needs-you=90s`,
    `change=1s-2s,needs-you=${"9".repeat(400)}m`,
    "change=1s-2s,needs-you=721h",
  ])("rejects %j", (text) => {
    expect(() => parsePace(text)).toThrow(/pace/i);
  });

  it("formats a pace back to its name", () => {
    expect(formatPace(CALM)).toBe("calm");
    expect(formatPace(parsePace("change=2s-6s,needs-you=90s"))).toBe("change=2s-6s,needs-you=90s");
  });
});

describe("parseDuration", () => {
  it.each([
    ["90s", 90_000],
    ["10m", 600_000],
    ["2h", 7_200_000],
    ["1.5h", 5_400_000],
  ])("%s is %d ms", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(["", "10", "-1s", "1d", "s", "1e3s"])("rejects %j", (text) => {
    expect(() => parseDuration(text)).toThrow();
  });

  it("accepts up to 30 days and rejects anything longer, including digits that overflow", () => {
    expect(MAX_DURATION_MS).toBe(30 * 24 * 3_600_000);
    expect(parseDuration("720h")).toBe(MAX_DURATION_MS);
    expect(() => parseDuration("720.5h")).toThrow(/30 days/);
    expect(() => parseDuration(`${"9".repeat(400)}h`)).toThrow(/30 days/);
    expect(() => parseDuration(`${"9".repeat(400)}.5s`)).toThrow(/30 days/);
  });
});

describe("isoFromMs", () => {
  it("matches Date.toISOString without reading a clock", () => {
    for (const ms of [
      0,
      1,
      951_782_400_000,
      Date.UTC(2026, 0, 1, 9),
      Date.UTC(2028, 1, 29, 23, 59, 59, 999),
      4_102_444_800_000,
    ]) {
      expect(isoFromMs(ms)).toBe(new Date(ms).toISOString());
    }
  });
});
