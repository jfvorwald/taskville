import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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
  const view = (
    dirs: Record<string, number>,
    links: Record<string, string> = {},
    owners: Record<string, number> = {},
  ) => ({
    realpath: (p: string) => {
      const link = Object.entries(links).find(([from]) => p === from || p.startsWith(`${from}/`));
      return link === undefined ? p : link[1] + p.slice(link[0].length);
    },
    lstat: (p: string) =>
      p in links
        ? stat({ kind: "link", mode: 0o120777 })
        : p in dirs
          ? stat({ mode: dirs[p] ?? 0, uid: owners[p] ?? 1000 })
          : undefined,
  });
  const ME = 1000;

  it("accepts parents that others cannot write, and sticky world-writable ones", () => {
    const v = view({ "/": 0o40755, "/home": 0o40755, "/home/u": 0o40700, "/tmp": 0o41777 });
    expect(parentDirProblem("/home/u/.taskville", v, ME)).toBeUndefined();
    expect(parentDirProblem("/tmp/.taskville", v, ME)).toBeUndefined();
  });

  it("refuses a parent others can write without the sticky bit", () => {
    const v = view({ "/": 0o40755, "/home": 0o40755, "/home/u": 0o40777 });
    expect(parentDirProblem("/home/u/.taskville", v, ME)).toMatch(/\/home\/u is writable by/);
  });

  it("refuses a group-writable parent without the sticky bit, and walks above the first parent", () => {
    const v = view({ "/": 0o40755, "/home": 0o40775, "/home/u": 0o40700 });
    expect(parentDirProblem("/home/u/.taskville", v, ME)).toMatch(/\/home is writable by/);
  });

  it("refuses a sticky world-writable parent that another user owns, accepts root's and ours", () => {
    const dirs = { "/": 0o40755, "/shared": 0o41777 };
    expect(parentDirProblem("/shared/.taskville", view(dirs, {}, { "/shared": 2000 }), ME)).toMatch(
      /\/shared is owned by another user/,
    );
    expect(
      parentDirProblem("/shared/.taskville", view(dirs, {}, { "/shared": 0 }), ME),
    ).toBeUndefined();
    expect(
      parentDirProblem("/shared/.taskville", view(dirs, {}, { "/shared": ME }), ME),
    ).toBeUndefined();
  });

  it("refuses a parent another user owns even without write bits for others", () => {
    const v = view({ "/": 0o40755, "/srv": 0o40755 }, {}, { "/srv": 2000 });
    expect(parentDirProblem("/srv/.taskville", v, ME)).toMatch(/\/srv is owned by another user/);
  });

  it("checks the directories holding a symlink on the way, not only where it points", () => {
    // /shared/link -> /private/real; /shared is writable by others, /private/real is not.
    const v = view(
      { "/": 0o40755, "/shared": 0o40777, "/private": 0o40755, "/private/real": 0o40700 },
      { "/shared/link": "/private/real" },
    );
    expect(parentDirProblem("/shared/link/.taskville", v, ME)).toMatch(/\/shared is writable by/);
  });

  it("starts at the nearest existing ancestor when the home does not exist yet", () => {
    const v = view({ "/": 0o40755, "/home": 0o40755, "/home/u": 0o40777 });
    expect(parentDirProblem("/home/u/a/b/.taskville", v, ME)).toMatch(/\/home\/u is writable by/);
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
