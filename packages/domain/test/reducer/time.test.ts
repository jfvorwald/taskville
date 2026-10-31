import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareTimestamps, laterTimestamp } from "../../src/reducer/entities/time.ts";

// Reference only: Date.parse handles these ISO forms in V8. src never uses Date.
const refMillis = (ts: string): number => Date.parse(ts);

describe("compareTimestamps", () => {
  it("orders by instant, honoring offsets", () => {
    expect(compareTimestamps("2026-10-30T12:00:00+02:00", "2026-10-30T10:00:00Z")).toBe(0);
    expect(compareTimestamps("2026-10-30T10:30:00Z", "2026-10-30T12:00:00+02:00")).toBe(1);
    expect(compareTimestamps("2026-10-30T09:00:00-02:00", "2026-10-30T10:59:59Z")).toBe(1);
    expect(compareTimestamps("2026-10-30T10:00:00-00:00", "2026-10-30T10:00:00Z")).toBe(0);
  });

  it("compares fractional seconds at any precision", () => {
    expect(compareTimestamps("2026-10-30T10:00:00.5Z", "2026-10-30T10:00:00.50000Z")).toBe(0);
    expect(
      compareTimestamps("2026-10-30T10:00:00.123456789Z", "2026-10-30T10:00:00.1234568Z"),
    ).toBe(-1);
    expect(compareTimestamps("2026-10-30T10:00:00Z", "2026-10-30T10:00:00.000001Z")).toBe(-1);
  });

  it("handles leap years, month ends, and the year 0000", () => {
    expect(compareTimestamps("2024-02-29T23:59:59Z", "2024-03-01T00:00:00Z")).toBe(-1);
    expect(compareTimestamps("0000-01-01T00:00:00Z", "1970-01-01T00:00:00Z")).toBe(-1);
    expect(compareTimestamps("2026-12-31T23:00:00-01:00", "2027-01-01T00:00:00Z")).toBe(0);
  });

  it("agrees with Date.parse to the millisecond", () => {
    const ts = fc
      .record({
        ms: fc.integer({ min: Date.UTC(1971, 0, 1), max: Date.UTC(2099, 0, 1) }),
        offset: fc.integer({ min: -14 * 60, max: 14 * 60 }),
      })
      .map(({ ms, offset }) => {
        const local = new Date(ms + offset * 60_000).toISOString().slice(0, 23);
        if (offset === 0) return `${local}Z`;
        const sign = offset > 0 ? "+" : "-";
        const abs = Math.abs(offset);
        const hh = String(Math.floor(abs / 60)).padStart(2, "0");
        const mm = String(abs % 60).padStart(2, "0");
        return `${local}${sign}${hh}:${mm}`;
      });
    fc.assert(
      fc.property(ts, ts, (a, b) => {
        expect(compareTimestamps(a, b)).toBe(Math.sign(refMillis(a) - refMillis(b)));
      }),
    );
  });

  it("rejects text that is not a protocol timestamp", () => {
    expect(() => compareTimestamps("yesterday", "2026-10-30T10:00:00Z")).toThrow(RangeError);
  });
});

describe("laterTimestamp", () => {
  it("returns the later instant, keeping the first on a tie", () => {
    expect(laterTimestamp("2026-10-30T12:00:00+02:00", "2026-10-30T10:00:01Z")).toBe(
      "2026-10-30T10:00:01Z",
    );
    expect(laterTimestamp("2026-10-30T12:00:00+02:00", "2026-10-30T10:00:00Z")).toBe(
      "2026-10-30T12:00:00+02:00",
    );
  });
});
