import { describe, expect, it } from "vitest";
import { describeCounts, formatCounts } from "../../../src/overlays/header/counts.ts";

describe("formatCounts", () => {
  it("renders the header line", () => {
    expect(formatCounts({ active: 3, needsYou: 1 })).toBe("3 active · 1 needs you");
  });

  it("renders zeros plainly", () => {
    expect(formatCounts({ active: 0, needsYou: 0 })).toBe("0 active · 0 need you");
  });

  it("uses 'need you' for any count but one", () => {
    expect(formatCounts({ active: 5, needsYou: 2 })).toBe("5 active · 2 need you");
  });

  it("clamps junk to non-negative whole numbers", () => {
    expect(formatCounts({ active: -2, needsYou: 1.7 })).toBe("0 active · 1 needs you");
    expect(formatCounts({ active: Number.NaN, needsYou: 0 })).toBe("0 active · 0 need you");
  });
});

describe("describeCounts", () => {
  it("spells the counts out for assistive tech", () => {
    expect(describeCounts({ active: 3, needsYou: 1 })).toBe("3 agents active, 1 needs you");
    expect(describeCounts({ active: 1, needsYou: 0 })).toBe("1 agent active, 0 need you");
  });
});
