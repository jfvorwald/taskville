import { describe, expect, it } from "vitest";
import { duplicateKey, parseSettings } from "../../src/commands/install-settings.ts";

// The duplicate-key check behind strict settings parsing (roborev 5210).

describe("duplicateKey", () => {
  it.each([
    [`{"a": 1, "a": 2}`, "a"],
    [`{"x": {"b": 1, "c": {"d": 0}, "b": 2}}`, "b"],
    [`{"a": 1, "\\u0061": 2}`, "a"],
    [`[{"k": 1}, {"k": 2, "k": 3}]`, "k"],
  ])("finds the duplicate in %s", (text, key) => {
    expect(duplicateKey(text)).toBe(key);
  });

  it.each([
    `{"a": 1, "b": {"a": 2}}`,
    `[{"k": 1}, {"k": 2}]`,
    `{"a": "}\\", \\"a\\": {", "b": ["a", "a"]}`,
    `{"a": [1, {"a": 2}], "b": 3}`,
    `{}`,
  ])("finds none in %s", (text) => {
    expect(duplicateKey(text)).toBeUndefined();
  });

  it("makes parseSettings refuse the file without naming the key", () => {
    expect(() => parseSettings(`{"DB_PASSWORD": "x", "DB_PASSWORD": "y"}`)).toThrow(
      /duplicate key/,
    );
    expect(() => parseSettings(`{"DB_PASSWORD": "x", "DB_PASSWORD": "y"}`)).not.toThrow(
      /DB_PASSWORD/,
    );
  });
});
