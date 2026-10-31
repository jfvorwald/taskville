import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateToken, TokenFileError } from "../../src/auth/token-file.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "taskville-token-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("loadOrCreateToken", () => {
  it("creates a missing token file with mode 0600 and returns its token", () => {
    const path = join(home, "token");
    const token = loadOrCreateToken(path);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe(token);
  });

  it("returns the same token on later loads", () => {
    const path = join(home, "token");
    expect(loadOrCreateToken(path)).toBe(loadOrCreateToken(path));
  });

  it("refuses a token file readable by group or others", () => {
    const path = join(home, "token");
    writeFileSync(path, `${"a".repeat(43)}\n`, { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => loadOrCreateToken(path)).toThrow(TokenFileError);
  });

  it("refuses a symlinked token file", () => {
    const target = join(home, "elsewhere");
    writeFileSync(target, "a".repeat(43), { mode: 0o600 });
    const path = join(home, "token");
    symlinkSync(target, path);
    expect(() => loadOrCreateToken(path)).toThrow(TokenFileError);
  });

  it("refuses a FIFO at the token path without blocking", () => {
    const path = join(home, "token");
    execFileSync("mkfifo", ["-m", "600", path]);
    expect(() => loadOrCreateToken(path)).toThrow(TokenFileError);
  }, 2000);

  it("refuses a token that is too short to be a real secret", () => {
    const path = join(home, "token");
    writeFileSync(path, "short\n", { mode: 0o600 });
    expect(() => loadOrCreateToken(path)).toThrow(TokenFileError);
  });

  it("never puts the token value in its error message", () => {
    const path = join(home, "token");
    const value = "s3cr3t-value-that-is-long-enough-to-pass-the-length-check";
    writeFileSync(path, value, { mode: 0o600 });
    chmodSync(path, 0o640);
    expect(() => loadOrCreateToken(path)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(value) }),
    );
  });
});
