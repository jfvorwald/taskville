import { describe, expect, it } from "vitest";
import { shouldSelectOnRelease } from "../../../src/city/interaction/pointer.ts";

describe("shouldSelectOnRelease", () => {
  it("selects on a pointerup that did not drag", () => {
    expect(shouldSelectOnRelease({ type: "pointerup", moved: false })).toBe(true);
  });

  it("does not select after a drag", () => {
    expect(shouldSelectOnRelease({ type: "pointerup", moved: true })).toBe(false);
  });

  it("never selects on pointercancel, dragged or not", () => {
    expect(shouldSelectOnRelease({ type: "pointercancel", moved: false })).toBe(false);
    expect(shouldSelectOnRelease({ type: "pointercancel", moved: true })).toBe(false);
  });
});
