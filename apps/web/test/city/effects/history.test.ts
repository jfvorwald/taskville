import { describe, expect, it } from "vitest";
import { createPlayedHistory, PLAYED_HISTORY_LIMIT } from "../../../src/city/effects/history.ts";

// The `?debug=celebrations` probe only needs recent entries, and the history is appended to on every
// celebration whether or not the probe is on, so it must stay bounded for the whole session.
describe("played history", () => {
  it("keeps at most the most recent 64 entries", () => {
    expect(PLAYED_HISTORY_LIMIT).toBe(64);
    const history = createPlayedHistory();
    for (let i = 0; i < 100; i += 1) history.push({ kind: "confetti", at: i });
    const entries = history.entries();
    expect(entries).toHaveLength(64);
    expect(entries.map((e) => e.at)).toEqual(Array.from({ length: 64 }, (_, i) => 36 + i));
  });

  it("returns every entry, oldest first, while under the limit", () => {
    const history = createPlayedHistory();
    history.push({ kind: "confetti", at: 1 });
    history.push({ kind: "high-five", at: 2 });
    history.push({ kind: "sparkle", at: 3 });
    expect(history.entries()).toEqual([
      { kind: "confetti", at: 1 },
      { kind: "high-five", at: 2 },
      { kind: "sparkle", at: 3 },
    ]);
  });

  it("starts empty", () => {
    expect(createPlayedHistory().entries()).toEqual([]);
  });

  it("honors a smaller limit", () => {
    const history = createPlayedHistory(3);
    for (let i = 0; i < 5; i += 1) history.push({ kind: "shimmer", at: i });
    expect(history.entries().map((e) => e.at)).toEqual([2, 3, 4]);
  });
});
