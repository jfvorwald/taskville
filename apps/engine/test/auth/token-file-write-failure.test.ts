import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Simulate a disk that fails mid-write (for example ENOSPC) on the token write only.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: () => {
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    },
    writeSync: () => {
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    },
  };
});

const { loadOrCreateToken } = await import("../../src/auth/token-file.ts");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "taskville-token-fail-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("loadOrCreateToken when the write fails", () => {
  it("removes the half-written file so the next start can create it again", () => {
    const path = join(home, "token");
    expect(() => loadOrCreateToken(path)).toThrow(/no space left/);
    expect(existsSync(path)).toBe(false);
  });
});
