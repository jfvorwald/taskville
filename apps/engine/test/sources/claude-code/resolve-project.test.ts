import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  matchProjectRoot,
  resolveProjectId,
} from "../../../src/sources/claude-code/resolve-project.ts";

const projects = [
  { id: "unsorted", roots: [], builtin: true },
  { id: "repo", roots: ["/work/repo"], builtin: false },
  { id: "nested", roots: ["/work/repo/packages/inner"], builtin: false },
  { id: "two-roots", roots: ["/work/a", "/work/b/"], builtin: false },
];

describe("matchProjectRoot (lexical)", () => {
  it("matches the root itself and anything below it", () => {
    expect(matchProjectRoot("/work/repo", projects)).toBe("repo");
    expect(matchProjectRoot("/work/repo/src/deep", projects)).toBe("repo");
    expect(matchProjectRoot("/work/b/x", projects)).toBe("two-roots");
    expect(matchProjectRoot("/work/a", projects)).toBe("two-roots");
  });

  it("prefers the longest matching root", () => {
    expect(matchProjectRoot("/work/repo/packages/inner/src", projects)).toBe("nested");
    expect(matchProjectRoot("/work/repo/packages", projects)).toBe("repo");
  });

  it("refuses sibling prefixes such as /work/repo-evil for /work/repo", () => {
    expect(matchProjectRoot("/work/repo-evil", projects)).toBeUndefined();
    expect(matchProjectRoot("/work/repox/src", projects)).toBeUndefined();
  });

  it("normalizes . and .. and repeated or trailing slashes before matching", () => {
    expect(matchProjectRoot("/work/repo/src/../../repo/./x//y/", projects)).toBe("repo");
    expect(matchProjectRoot("/work/repo/../elsewhere", projects)).toBeUndefined();
    expect(matchProjectRoot("/work/repo/..", projects)).toBeUndefined();
    // Climbing above / stays at /.
    expect(matchProjectRoot("/../../work/repo", projects)).toBe("repo");
  });

  it("normalizes configured roots too", () => {
    const loose = [{ id: "loose", roots: ["/work//loose/./x/../"], builtin: false }];
    expect(matchProjectRoot("/work/loose/src", loose)).toBe("loose");
  });

  it("breaks a tie between equal roots by project ID, so the answer does not depend on order", () => {
    const tied = [
      { id: "zeta", roots: ["/same"], builtin: false },
      { id: "alpha", roots: ["/same"], builtin: false },
    ];
    expect(matchProjectRoot("/same/x", tied)).toBe("alpha");
    expect(matchProjectRoot("/same/x", [...tied].reverse())).toBe("alpha");
  });

  it("never routes to a built-in project, whatever its roots", () => {
    const builtin = [{ id: "unsorted", roots: ["/work"], builtin: true }];
    expect(matchProjectRoot("/work/x", builtin)).toBeUndefined();
  });

  it("ignores configured roots that are not absolute", () => {
    const relative = [{ id: "rel", roots: ["work/repo", ""], builtin: false }];
    expect(matchProjectRoot("/work/repo", relative)).toBeUndefined();
  });
});

describe("resolveProjectId", () => {
  const noRealpath = async (): Promise<string> => {
    throw new Error("no such path");
  };

  it("sends a working directory under a configured root to that project", async () => {
    expect(await resolveProjectId("/work/repo/src", projects, { realpath: noRealpath })).toBe(
      "repo",
    );
  });

  it("sends an unknown, missing, or malformed working directory to Unsorted", async () => {
    const opts = { realpath: noRealpath };
    for (const cwd of [
      "/elsewhere",
      undefined,
      null,
      42,
      {},
      ["/work/repo"],
      "",
      "work/repo",
      "./work/repo",
      "~/repo",
      "/work/repo\u0000/x",
      "/work/repo/\n",
      "/work/repo/\uD800",
      `/work/repo/${"x".repeat(5000)}`,
    ]) {
      expect(await resolveProjectId(cwd, projects, opts), String(cwd).slice(0, 40)).toBe(
        "unsorted",
      );
    }
  });

  it("uses the reported path first and the resolved real path only when that matches nothing", async () => {
    // /work/repo/link -> /work/a/sub: the path as reported wins.
    const realpath = async (p: string) =>
      p === "/work/repo/link" ? "/work/a/sub" : p === "/tmp/x" ? "/private/tmp/x" : p;
    expect(await resolveProjectId("/work/repo/link", projects, { realpath })).toBe("repo");
    // Only the real path matches: a root configured through its real path.
    const realRoot = [{ id: "real", roots: ["/private/tmp/x"], builtin: false }];
    expect(await resolveProjectId("/tmp/x/src", realRoot, { realpath })).toBe("unsorted");
    expect(await resolveProjectId("/tmp/x", realRoot, { realpath })).toBe("real");
  });

  it("matches a cwd against a root's real path (root configured through a symlink)", async () => {
    const realpath = async (p: string) => (p === "/tmp/x" ? "/private/tmp/x" : p);
    const symlinkRoot = [{ id: "sym", roots: ["/tmp/x"], builtin: false }];
    expect(await resolveProjectId("/private/tmp/x/src", symlinkRoot, { realpath })).toBe("sym");
  });

  it("falls back to Unsorted when real path resolution fails", async () => {
    expect(await resolveProjectId("/nowhere", projects, { realpath: noRealpath })).toBe("unsorted");
  });

  describe("with the real file system", () => {
    let dir = "";
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("follows symlinks only as a fallback", async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "taskville-cwd-")));
      mkdirSync(join(dir, "repo", "src"), { recursive: true });
      symlinkSync(join(dir, "repo"), join(dir, "alias"));
      const real = [{ id: "repo", roots: [join(dir, "repo")], builtin: false }];
      expect(await resolveProjectId(join(dir, "alias", "src"), real)).toBe("repo");
      const viaAlias = [{ id: "alias", roots: [join(dir, "alias")], builtin: false }];
      expect(await resolveProjectId(join(dir, "repo", "src"), viaAlias)).toBe("alias");
      expect(await resolveProjectId(join(dir, "missing"), real)).toBe("unsorted");
    });
  });
});
