import { describe, expect, it } from "vitest";
import { batches, parseJsonl } from "../src/jsonl.ts";
import { cli } from "./helpers.ts";

describe("parseJsonl (contracts/events.md JSONL rules)", () => {
  it("numbers file lines, skips blank and // lines, and reports malformed ones", () => {
    expect(parseJsonl('// header\n\n{"a":1}\r\n  // note\nnot json\n[2]\n')).toEqual([
      { line: 3, ok: true, value: { a: 1 } },
      { line: 5, ok: false, error: expect.any(String) },
      { line: 6, ok: true, value: [2] },
    ]);
  });
});

describe("batches", () => {
  it("splits by count and by size", () => {
    const items = Array.from({ length: 2_500 }, (_, i) => ({ line: i + 1, value: { i } }));
    expect(batches(items, 1_000, 1e9).map((b) => b.length)).toEqual([1_000, 1_000, 500]);
    const big = Array.from({ length: 5 }, (_, i) => ({
      line: i + 1,
      value: { s: "x".repeat(100) },
    }));
    expect(batches(big, 1_000, 250).map((b) => b.length)).toEqual([2, 2, 1]);
  });
});

describe("arguments", () => {
  it("prints usage and exits 1 with no command or an unknown one", async () => {
    for (const argv of [[], ["fly"]]) {
      const result = await cli(argv);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/Usage: taskville/);
    }
  });

  it.each([
    [["status"], /--project/],
    [["status", "--project"], /project/],
    [["status", "--project", "demo", "--bogus"], /bogus/],
    [["events", "ingest"], /--file/],
    [["events", "dance"], /events/],
    [["project", "add"], /--name/],
    [["serve", "--port", "abc"], /port/],
  ])("rejects %j with exit 1", async (argv, message) => {
    const result = await cli(argv);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(message);
  });

  it("has no command or flag that answers a request (FR-018)", async () => {
    for (const argv of [
      ["requests", "--allow"],
      ["requests", "--deny"],
      ["requests", "answer"],
      ["allow"],
    ]) {
      expect((await cli(argv)).code).toBe(1);
    }
  });

  it("exits 5 when there is no token yet, without creating one", async () => {
    const result = await cli(["project", "list", "--home", "/nonexistent/taskville-home"]);
    expect(result.code).toBe(5);
    expect(result.stderr).toMatch(/token/);
  });
});
