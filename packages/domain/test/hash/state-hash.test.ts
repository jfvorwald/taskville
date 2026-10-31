import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical, sha256Hex, stateHash } from "../../src/hash/index.ts";

// Rebuilds a JSON value with every object's keys inserted in a different order,
// chosen by a seeded generator so a failure replays exactly. Object.fromEntries
// keeps "__proto__" as an own key, as JSON.parse does.
function reorderKeys(value: unknown, seed: number): unknown {
  let s = seed >>> 0 || 1;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v).map(([k, x]) => [k, walk(x)] as const);
      for (let i = entries.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [entries[i], entries[j]] = [
          entries[j] as (typeof entries)[number],
          entries[i] as (typeof entries)[number],
        ];
      }
      return Object.fromEntries(entries);
    }
    return v;
  };
  return walk(value);
}

describe("hashCanonical", () => {
  it("is the SHA-256 of the canonical JSON, as lowercase hex", () => {
    const value = { b: [1, 2], a: "x" };
    expect(hashCanonical(value)).toBe(sha256Hex('{"a":"x","b":[1,2]}'));
    expect(hashCanonical(value)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("property: key insertion order never changes the hash", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer(), (value, seed) => {
        const reordered = reorderKeys(value, seed);
        expect(canonicalJson(reordered)).toBe(canonicalJson(value));
        expect(hashCanonical(reordered)).toBe(hashCanonical(value));
      }),
      { numRuns: 500 },
    );
  });

  it("property: different canonical JSON gives a different hash", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        fc.pre(canonicalJson(a) !== canonicalJson(b));
        expect(hashCanonical(a)).not.toBe(hashCanonical(b));
      }),
    );
  });

  it("is stable across calls (pinned digest)", () => {
    // Pinned so an accidental change to the canonical form shows up as a failure.
    expect(hashCanonical({ agents: { b: { n: 2 }, a: { n: 1 } }, head: 3 })).toBe(
      sha256Hex('{"agents":{"a":{"n":1},"b":{"n":2}},"head":3}'),
    );
    expect(hashCanonical({ a: 1 })).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
  });
});

describe("stateHash", () => {
  it("prefixes the canonical hash with the reducer version", () => {
    const state = { z: 1, a: [] };
    expect(stateHash(3, state)).toBe(`3:${hashCanonical(state)}`);
  });

  it("differs across reducer versions for the same state", () => {
    expect(stateHash(1, {})).not.toBe(stateHash(2, {}));
  });

  it("rejects a reducer version that is not a non-negative safe integer", () => {
    for (const v of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => stateHash(v, {})).toThrow(RangeError);
    }
  });
});
