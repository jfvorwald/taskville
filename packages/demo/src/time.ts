// Time without a clock: the demo runs on a virtual clock (milliseconds since a start time), and
// timestamps are formatted by arithmetic so src never touches Date beyond Date.UTC.

/** Default start of the virtual clock, so offline runs are reproducible: 2026-01-01T09:00Z. */
export const DEMO_EPOCH_MS = Date.UTC(2026, 0, 1, 9, 0, 0);

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** The same string as `new Date(ms).toISOString()` for years 0 to 9999. */
export function isoFromMs(ms: number): string {
  const day = 86_400_000;
  const days = Math.floor(ms / day);
  let rest = ms - days * day;
  const hours = Math.floor(rest / 3_600_000);
  rest -= hours * 3_600_000;
  const minutes = Math.floor(rest / 60_000);
  rest -= minutes * 60_000;
  const seconds = Math.floor(rest / 1_000);
  const millis = rest - seconds * 1_000;
  // Civil date from days since 1970-01-01 (Howard Hinnant's days_from_civil, inverted).
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const date = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(date, 2)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}Z`;
}
