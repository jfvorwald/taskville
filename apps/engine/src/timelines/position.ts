// A position on a timeline: a decimal ingest sequence or a zoned ISO 8601 timestamp
// (contracts/http-api.md, "Timelines"). Anything looser is refused, so a client never gets a
// quiet guess at what "1e3" or "2026-01-01" meant.

export type Position = { kind: "sequence"; sequence: number } | { kind: "time"; ms: number };

const SEQUENCE = /^(0|[1-9][0-9]{0,15})$/;
const ZONED =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The position `raw` names, or undefined when it is neither a sequence nor a zoned timestamp. */
export function parsePosition(raw: string): Position | undefined {
  if (SEQUENCE.test(raw)) {
    const sequence = Number(raw);
    return Number.isSafeInteger(sequence) ? { kind: "sequence", sequence } : undefined;
  }
  const parts = ZONED.exec(raw);
  if (!parts) return undefined;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Date.parse rolls an impossible date (February 30) forward; refuse it instead.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : { kind: "time", ms };
}
