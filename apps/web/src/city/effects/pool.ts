// A fixed-capacity particle pool: the slots are allocated once, and a slot is free again when its
// lifetime has run out. Nothing is allocated per spawn or per frame.

export interface ParticlePoolOptions {
  readonly capacity: number;
  readonly lifetimeMs: number;
}

export interface ParticlePool {
  readonly capacity: number;
  /** Starts up to `count` particles at `nowMs`; returns how many got a slot (never over capacity). */
  spawn(count: number, nowMs: number): number;
  /** Particles still alive at `nowMs`. */
  activeCount(nowMs: number): number;
  /** Whether slot `index` is alive at `nowMs`. */
  isActive(index: number, nowMs: number): boolean;
  /** When slot `index` started, in the `nowMs` of its spawn; meaningful only while it is active. */
  startedAt(index: number): number;
}

export function createParticlePool({ capacity, lifetimeMs }: ParticlePoolOptions): ParticlePool {
  const expires = new Float64Array(capacity).fill(Number.NEGATIVE_INFINITY);

  return {
    capacity,
    spawn(count, nowMs) {
      let started = 0;
      for (let i = 0; i < capacity && started < count; i += 1) {
        if ((expires[i] ?? 0) > nowMs) continue;
        expires[i] = nowMs + lifetimeMs;
        started += 1;
      }
      return started;
    },
    activeCount(nowMs) {
      let active = 0;
      for (let i = 0; i < capacity; i += 1) if ((expires[i] ?? 0) > nowMs) active += 1;
      return active;
    },
    isActive: (index, nowMs) => (expires[index] ?? Number.NEGATIVE_INFINITY) > nowMs,
    startedAt: (index) => (expires[index] ?? 0) - lifetimeMs,
  };
}
