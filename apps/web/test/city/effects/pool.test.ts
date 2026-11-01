import { describe, expect, it } from "vitest";
import { createParticlePool } from "../../../src/city/effects/pool.ts";

describe("particle pool", () => {
  it("never holds more than its capacity, however many are asked for", () => {
    const pool = createParticlePool({ capacity: 40, lifetimeMs: 1200 });
    expect(pool.spawn(30, 0)).toBe(30);
    expect(pool.spawn(30, 0)).toBe(10);
    expect(pool.activeCount(0)).toBe(40);
    expect(pool.spawn(1, 0)).toBe(0);
  });

  it("releases particles after their lifetime so they can be reused", () => {
    const pool = createParticlePool({ capacity: 40, lifetimeMs: 1200 });
    pool.spawn(40, 0);
    expect(pool.activeCount(1199)).toBe(40);
    expect(pool.activeCount(1200)).toBe(0);
    expect(pool.spawn(25, 1200)).toBe(25);
    expect(pool.activeCount(1200)).toBe(25);
  });

  it("frees only the expired particles when spawns are staggered", () => {
    const pool = createParticlePool({ capacity: 10, lifetimeMs: 1000 });
    pool.spawn(4, 0);
    pool.spawn(6, 500);
    expect(pool.activeCount(1000)).toBe(6);
    expect(pool.spawn(10, 1000)).toBe(4);
  });
});
