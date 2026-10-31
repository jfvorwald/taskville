// Seeded randomness. mulberry32 is a small, fast 32-bit PRNG: good enough to vary a demo, and
// identical on every JavaScript engine, so a seed always replays the same scenario.

export type Random = () => number;

/** mulberry32: returns floats in [0, 1). The seed is taken as a uint32. */
export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next: Random;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** `length` lowercase hex digits. */
  hex(length: number): string;
}

export function seededRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (min: number, max: number) => {
    if (max < min) throw new Error(`rng.int: max ${max} is below min ${min}`);
    return min + Math.floor(next() * (max - min + 1));
  };
  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("rng.pick: no items");
      return items[int(0, items.length - 1)] as T;
    },
    hex: (length) => {
      let out = "";
      while (out.length < length) out += int(0, 15).toString(16);
      return out;
    },
  };
}
