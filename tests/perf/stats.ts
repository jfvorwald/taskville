// Small statistics helpers for the perf checks (tests/perf). Pure.

/** Nearest-rank percentile: the smallest sample with at least p% of samples at or below it. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new RangeError("percentile of an empty sample");
  if (!(p > 0 && p <= 100)) throw new RangeError("percentile must be in (0, 100]");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1] as number;
}

export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new RangeError("median of an empty sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Relative change from `before` to `after` (0.09 is 9% growth). */
export function growth(before: number, after: number): number {
  if (before <= 0) throw new RangeError("growth needs a positive starting value");
  return (after - before) / before;
}

export interface Summary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarize(samples: readonly number[]): Summary {
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: percentile(samples, 100),
  };
}

/** Whole simulated hours between the run's start and an event's `occurredAt`. */
export function simulatedHour(startAtMs: number, occurredAt: string): number {
  return Math.floor((Date.parse(occurredAt) - startAtMs) / 3_600_000);
}
