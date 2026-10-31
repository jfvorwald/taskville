import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkShim,
  installShim,
  parentDirProblem,
  privateDirProblem,
  type StatLike,
} from "../../src/commands/install-files.ts";
import { guardRealSettings, mode, type Sandbox, sandbox, tv } from "./helpers.ts";

// M2.23 (#212, M2.11 F3): the installer applies the engine's rule to the Taskville home and its
// hooks directory: refuse another owner and group/other write; refuse a parent others can write
// without the sticky bit. A refusal says why and changes nothing.

guardRealSettings();

let sb: Sandbox;
afterEach(() => sb?.remove());

const stat = (over: Partial<{ uid: number; mode: number; kind: "dir" | "link" | "file" }> = {}) =>
  ({
    uid: over.uid ?? 1000,
    mode: over.mode ?? 0o40700,
    isDirectory: () => (over.kind ?? "dir") === "dir",
    isSymbolicLink: () => over.kind === "link",
  }) satisfies StatLike;

describe("privateDirProblem (injected stat)", () => {
  it("accepts a directory we own with no group or other write", () => {
    expect(privateDirProblem("/h", stat({ mode: 0o40700 }), 1000)).toBeUndefined();
    expect(privateDirProblem("/h", stat({ mode: 0o40755 }), 1000)).toBeUndefined();
  });

  it("refuses a directory another uid owns", () => {
    expect(privateDirProblem("/h", stat({ uid: 1001 }), 1000)).toMatch(/owned by another user/);
  });

  it("refuses group and other write, each alone", () => {
    expect(privateDirProblem("/h", stat({ mode: 0o40770 }), 1000)).toMatch(/group or other/);
    expect(privateDirProblem("/h", stat({ mode: 0o40707 }), 1000)).toMatch(/group or other/);
    expect(privateDirProblem("/h", stat({ mode: 0o41777 }), 1000)).toMatch(/group or other/);
  });

  it("still refuses a symlink and a non-directory", () => {
    expect(privateDirProblem("/h", stat({ kind: "link" }), 1000)).toMatch(/symlink/);
    expect(privateDirProblem("/h", stat({ kind: "file" }), 1000)).toMatch(/not a directory/);
  });

  it("skips the owner check where there is no uid (Windows)", () => {
    expect(privateDirProblem("/h", stat({ uid: 7 }), undefined)).toBeUndefined();
  });
});

describe("parentDirProblem (injected stat)", () => {
  const ME = 1000;
  /** `dirs` are directories by path and mode; `links` map a link path to its target. */
  const view = (
    dirs: Record<string, number>,
    links: Record<string, string> = {},
    owners: Record<string, number> = {},
  ) => ({
    readlink: (p: string) => links[p] ?? "",
    lstat: (p: string) =>
      p in links
        ? stat({ kind: "link", mode: 0o120777, uid: owners[p] ?? ME })
        : p in dirs
          ? stat({ mode: dirs[p] ?? 0, uid: owners[p] ?? ME })
          : undefined,
  });
  const problem = (path: string, v: ReturnType<typeof view>) => parentDirProblem(path, v, ME);

  it("accepts parents that others cannot write, and sticky world-writable ones", () => {
    const v = view({ "/": 0o40755, "/home": 0o40755, "/home/u": 0o40700, "/tmp": 0o41777 });
    expect(problem("/home/u/.taskville", v)).toBeUndefined();
    expect(problem("/tmp/.taskville", v)).toBeUndefined();
  });

  it("refuses a parent others can write without the sticky bit", () => {
    const v = view({ "/": 0o40755, "/home": 0o40755, "/home/u": 0o40777 });
    expect(problem("/home/u/.taskville", v)).toMatch(/\/home\/u is writable by/);
  });

  it("refuses a group-writable parent without the sticky bit, and walks above the first parent", () => {
    const v = view({ "/": 0o40755, "/home": 0o40775, "/home/u": 0o40700 });
    expect(problem("/home/u/.taskville", v)).toMatch(/\/home is writable by/);
  });

  it("starts at the nearest existing ancestor when the home does not exist yet", () => {
    const v = view({ "/": 0o40755, "/home": 0o40755, "/home/u": 0o40777 });
    expect(problem("/home/u/a/b/.taskville", v)).toMatch(/\/home\/u is writable by/);
  });

  it("refuses a sticky world-writable parent that another user owns, accepts root's and ours", () => {
    const dirs = { "/": 0o40755, "/shared": 0o41777 };
    expect(problem("/shared/.taskville", view(dirs, {}, { "/shared": 2000 }))).toMatch(
      /\/shared is owned by another user/,
    );
    expect(problem("/shared/.taskville", view(dirs, {}, { "/shared": 0 }))).toBeUndefined();
    expect(problem("/shared/.taskville", view(dirs, {}, { "/shared": ME }))).toBeUndefined();
  });

  it("refuses a parent another user owns even without write bits for others", () => {
    const v = view({ "/": 0o40755, "/srv": 0o40755 }, {}, { "/srv": 2000 });
    expect(problem("/srv/.taskville", v)).toMatch(/\/srv is owned by another user/);
  });

  it("checks the directory holding a symlink on the way, not only where it points", () => {
    const v = view(
      { "/": 0o40755, "/shared": 0o40777, "/private": 0o40755, "/private/real": 0o40700 },
      { "/shared/link": "/private/real" },
    );
    expect(problem("/shared/link/.taskville", v)).toMatch(/\/shared is writable by/);
  });

  it("follows chained symlinks, and checks where each one points", () => {
    const v = view(
      {
        "/": 0o40755,
        "/safe": 0o40700,
        "/shared": 0o40777,
        "/private": 0o40755,
        "/private/real": 0o40700,
      },
      { "/safe/link": "/shared/hop", "/shared/hop": "/private/real" },
    );
    expect(problem("/safe/link/.taskville", v)).toMatch(/\/shared is writable by/);
  });

  it("checks the target of a symlink, relative ones included", () => {
    const dirs = { "/": 0o40755, "/home": 0o40755, "/home/u": 0o40700, "/w": 0o40777 };
    expect(problem("/home/u/l/.taskville", view(dirs, { "/home/u/l": "/w" }))).toMatch(
      /\/w is writable by/,
    );
    const rel = view({ ...dirs, "/w/x": 0o40700 }, { "/home/u/l": "../../w/x" });
    expect(problem("/home/u/l/.taskville", rel)).toMatch(/\/w is writable by/);
  });

  it("refuses a symlink on the way that another user owns, even in a root-owned sticky dir", () => {
    const v = view(
      { "/": 0o40755, "/shared": 0o41770, "/private": 0o40700 },
      { "/shared/link": "/private" },
      { "/shared": 0, "/shared/link": 2000 },
    );
    expect(problem("/shared/link/.taskville", v)).toMatch(/symlink owned by another user/);
  });

  it("gives up on a symlink loop", () => {
    const v = view({ "/": 0o40755 }, { "/a": "/b", "/b": "/a" });
    expect(problem("/a/.taskville", v)).toMatch(/too many symlinks/);
  });
});

describe("install against a home that is not private", () => {
  const args = (box: Sandbox) => [
    "install",
    "claude-code",
    "--scope",
    "user",
    "--yes",
    "--home",
    box.tv,
  ];

  it("refuses a 0777 Taskville home and changes nothing", async () => {
    sb = sandbox();
    mkdirSync(sb.tv, { mode: 0o700 });
    chmodSync(sb.tv, 0o777);
    const r = await tv(sb, args(sb));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/group or other/);
    expect(existsSync(sb.shim)).toBe(false);
    expect(existsSync(join(sb.tv, "hooks"))).toBe(false);
    expect(existsSync(sb.userSettings)).toBe(false);
    expect(mode(sb.tv)).toBe(0o777);
  });

  it("refuses a group-writable hooks directory and does not replace the shim", async () => {
    sb = sandbox();
    mkdirSync(dirname(sb.shim), { recursive: true, mode: 0o700 });
    writeFileSync(sb.shim, "#!/bin/sh\n# old\n", { mode: 0o755 });
    chmodSync(dirname(sb.shim), 0o770);
    const r = await tv(sb, args(sb));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/group or other/);
    expect(statSync(sb.shim).size).toBe("#!/bin/sh\n# old\n".length);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("refuses a 0777 parent without the sticky bit, even when the home does not exist", async () => {
    sb = sandbox();
    chmodSync(sb.home, 0o777);
    const r = await tv(sb, args(sb));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/writable by/);
    expect(r.stderr).toContain(sb.home);
    expect(existsSync(sb.tv)).toBe(false);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("dry-run (checkShim) refuses a 0777 parent for a home that does not exist yet", () => {
    sb = sandbox();
    chmodSync(sb.home, 0o777);
    expect(() => checkShim(sb.tv, "s.sh", "#!/bin/sh\n")).toThrow(/writable by/);
  });

  it("refuses a home reached through a symlink that sits in a directory others can write", async () => {
    sb = sandbox();
    const shared = join(sb.root, "shared");
    const real = join(sb.root, "real");
    mkdirSync(shared, { mode: 0o700 });
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(shared, "link"));
    chmodSync(shared, 0o777);
    const home = join(shared, "link", ".taskville");
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes", "--home", home]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(shared);
    expect(existsSync(join(real, ".taskville"))).toBe(false);
  });

  it("accepts a 0777 parent that has the sticky bit", async () => {
    sb = sandbox();
    chmodSync(sb.home, 0o1777);
    const r = await tv(sb, args(sb));
    expect(r.code, r.stderr).toBe(0);
  });

  it("checkShim and installShim refuse a 0777 home directly", () => {
    sb = sandbox();
    mkdirSync(sb.tv, { mode: 0o700 });
    chmodSync(sb.tv, 0o777);
    expect(() => checkShim(sb.tv, "s.sh", "#!/bin/sh\n")).toThrow(/group or other/);
    expect(() => installShim(sb.tv, "s.sh", "#!/bin/sh\n")).toThrow(/group or other/);
    expect(existsSync(join(sb.tv, "hooks"))).toBe(false);
  });
});
