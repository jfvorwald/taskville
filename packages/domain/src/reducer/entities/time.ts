// Comparing protocol timestamps without the clock or Date.
//
// Protocol timestamps are ISO-8601 with seconds and an offset (`Z` or `+hh:mm`), with any number
// of fractional digits. Text order is not time order once offsets differ, and Date.parse is only
// specified for millisecond precision, so the instant is computed by hand: whole seconds since
// the epoch, plus the fractional digits compared as a decimal string.

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

interface Instant {
  seconds: number;
  fraction: string;
}

function instant(ts: string): Instant {
  const m = TIMESTAMP.exec(ts);
  if (m === null) throw new RangeError(`not a protocol timestamp: ${ts}`);
  const n = (i: number): number => Number(m[i] ?? "0");
  let seconds = daysFromCivil(n(1), n(2), n(3)) * 86_400 + n(4) * 3600 + n(5) * 60 + n(6);
  if (m[8] !== undefined) {
    const offset = n(9) * 3600 + n(10) * 60;
    seconds += m[8] === "+" ? -offset : offset;
  }
  return { seconds, fraction: (m[7] ?? "").replace(/0+$/, "") };
}

/** Days from 1970-01-01 to a proleptic Gregorian date (H. Hinnant's days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** -1, 0, or 1 as `a` is earlier than, the same instant as, or later than `b`. */
export function compareTimestamps(a: string, b: string): -1 | 0 | 1 {
  const x = instant(a);
  const y = instant(b);
  if (x.seconds !== y.seconds) return x.seconds < y.seconds ? -1 : 1;
  const width = Math.max(x.fraction.length, y.fraction.length);
  const fx = x.fraction.padEnd(width, "0");
  const fy = y.fraction.padEnd(width, "0");
  if (fx === fy) return 0;
  return fx < fy ? -1 : 1;
}

/**
 * Milliseconds since the epoch, fractional digits beyond the millisecond dropped. For elapsed
 * time against an injected clock (the silent-trouble selector); use `compareTimestamps` to order.
 */
export function epochMillis(ts: string): number {
  const { seconds, fraction } = instant(ts);
  return seconds * 1000 + Number(fraction.slice(0, 3).padEnd(3, "0"));
}

/** The later of two timestamps; `current` on a tie, so the stored text does not churn. */
export const laterTimestamp = (current: string, candidate: string): string =>
  compareTimestamps(candidate, current) > 0 ? candidate : current;

/** The earlier of two timestamps; `current` on a tie. */
export const earlierTimestamp = (current: string, candidate: string): string =>
  compareTimestamps(candidate, current) < 0 ? candidate : current;
