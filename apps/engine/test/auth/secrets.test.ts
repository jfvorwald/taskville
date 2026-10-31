import { describe, expect, it } from "vitest";
import { generateSecret, safeEqual } from "../../src/auth/secrets.ts";

describe("generateSecret", () => {
  it("returns a base64url string carrying 256 bits", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateSecret()));
    expect(seen.size).toBe(100);
  });
});

describe("safeEqual", () => {
  it("is true for identical strings", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
  });

  it("is false for different strings of the same length", () => {
    expect(safeEqual("abc123", "abc124")).toBe(false);
  });

  it("is false for different lengths, including a prefix", () => {
    expect(safeEqual("abc", "abc123")).toBe(false);
    expect(safeEqual("abc123", "")).toBe(false);
  });
});
