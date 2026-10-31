import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureHome, HomeError, homePaths, resolveHome } from "../../src/config/home.ts";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "taskville-home-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe("resolveHome", () => {
  const base = { homedir: "/home/user", cwd: "/work" };

  it("defaults to ~/.taskville", () => {
    expect(resolveHome({ ...base, env: {} })).toBe("/home/user/.taskville");
  });

  it("uses TASKVILLE_HOME over the default, ignoring an empty value", () => {
    expect(resolveHome({ ...base, env: { TASKVILLE_HOME: "/data/tv" } })).toBe("/data/tv");
    expect(resolveHome({ ...base, env: { TASKVILLE_HOME: "" } })).toBe("/home/user/.taskville");
  });

  it("uses the --home flag over TASKVILLE_HOME", () => {
    expect(resolveHome({ ...base, flag: "/flag/tv", env: { TASKVILLE_HOME: "/data/tv" } })).toBe(
      "/flag/tv",
    );
  });

  it("resolves relative paths against cwd and expands a leading ~/", () => {
    expect(resolveHome({ ...base, flag: "tv", env: {} })).toBe("/work/tv");
    expect(resolveHome({ ...base, env: { TASKVILLE_HOME: "~/tv" } })).toBe("/home/user/tv");
  });
});

describe("homePaths", () => {
  it("lays out the home directory", () => {
    expect(homePaths("/h")).toEqual({
      home: "/h",
      config: "/h/config.json",
      token: "/h/token",
      bridgeToken: "/h/bridge-token",
      db: "/h/taskville.db",
      evidenceDb: "/h/evidence.db",
      spoolDir: "/h/spool",
    });
  });
});

describe("ensureHome", () => {
  it("creates the home 0700, the spool 0700, and both token files 0600, even with umask 0", () => {
    const home = join(scratch, "nested", "tv");
    const previous = process.umask(0);
    let result: ReturnType<typeof ensureHome>;
    try {
      result = ensureHome(home);
    } finally {
      process.umask(previous);
    }
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, "spool"))).toBe(0o700);
    expect(mode(join(home, "token"))).toBe(0o600);
    expect(mode(join(home, "bridge-token"))).toBe(0o600);
    expect(result.paths).toEqual(homePaths(home));
    expect(result.cliToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.bridgeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.cliToken).not.toBe(result.bridgeToken);
  });

  it("is idempotent and keeps existing tokens", () => {
    const home = join(scratch, "tv");
    const first = ensureHome(home);
    const second = ensureHome(home);
    expect(second.cliToken).toBe(first.cliToken);
    expect(second.bridgeToken).toBe(first.bridgeToken);
  });

  it("tightens an existing home or spool that others can read", () => {
    const home = join(scratch, "tv");
    mkdirSync(join(home, "spool"), { recursive: true });
    chmodSync(home, 0o755);
    chmodSync(join(home, "spool"), 0o777);
    ensureHome(home);
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, "spool"))).toBe(0o700);
  });

  it("refuses a home path that is a file", () => {
    const home = join(scratch, "tv");
    writeFileSync(home, "not a directory");
    expect(() => ensureHome(home)).toThrow(HomeError);
  });

  it("refuses a symlinked home or spool without touching the target's mode", () => {
    const target = join(scratch, "elsewhere");
    mkdirSync(target);
    chmodSync(target, 0o755);
    const home = join(scratch, "tv");
    symlinkSync(target, home);
    expect(() => ensureHome(home)).toThrow(HomeError);
    expect(mode(target)).toBe(0o755);

    const realHome = join(scratch, "real");
    mkdirSync(realHome);
    symlinkSync(target, join(realHome, "spool"));
    expect(() => ensureHome(realHome)).toThrow(HomeError);
    expect(mode(target)).toBe(0o755);
  });

  it("refuses a CLI token file equal to the bridge token file", () => {
    const home = join(scratch, "tv");
    const { cliToken } = ensureHome(home);
    writeFileSync(join(home, "bridge-token"), `${cliToken}\n`, { mode: 0o600 });
    expect(() => ensureHome(home)).toThrow(HomeError);
  });
});
