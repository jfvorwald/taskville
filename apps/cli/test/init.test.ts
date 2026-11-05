import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, freePort, startServe, tempDir } from "./helpers.ts";

// M7.10 (#382): `taskville init`. Red-phase tests.
//
// New command src/commands/init.ts, registered in main.ts:
//   taskville init [--name <name>] [--yes] [--no-hooks] [--home <dir>] [--url <base>]
// Seams (no new ones; everything is real but sandboxed):
//   - A real engine: startServe() runs `serve --headless` in process on a free loopback port with
//     a temp Taskville home; init talks to it with --home and --url like `project add` does.
//   - Git: real `git init` in a temp directory; init asks Git for the top-level (so a symlinked
//     temp dir shows up as its realpath, which is what the tests expect).
//   - Hooks: the existing install flow. HOME is a temp directory, the project scope target is
//     <git top-level>/.claude/settings.local.json. `io.confirm` is the question seam (same as
//     install): called once with a question that names the settings file; `--yes` skips it,
//     `--no-hooks` skips the whole offer.
// Contract decided here for the implementer:
//   - Success prints a sentence containing the project name; exit 0.
//   - A second run prints "already set up" (any case) and exits 0 with no second project.
//   - Declining the hook question, or no TTY without --yes, still exits 0 (the project is added)
//     and says how to install later (`taskville install claude-code`).
//   - Outside Git: exit 1, stderr is one sentence mentioning "Git repository", engine never asked.
//   - No running engine: exit nonzero, stderr points at `taskville start`.

const dirs: { remove: () => void }[] = [];
afterAll(() => {
  for (const d of dirs) d.remove();
});

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A Git repo in a temp dir, a temp HOME, and a temp Taskville home. */
function sandbox() {
  const dir = tempDir("taskville-init-");
  dirs.push(dir);
  const repo = join(dir.path, "my-app");
  const home = join(dir.path, "home");
  const tv = join(dir.path, "tv");
  mkdirSync(repo);
  mkdirSync(home);
  mkdirSync(tv);
  git(repo, "init", "-q");
  return { root: dir.path, repo, top: realpathSync(repo), home, tv };
}

describe("taskville init", () => {
  const engineHome = tempDir("taskville-init-engine-");
  dirs.push(engineHome);
  let serve: Awaited<ReturnType<typeof startServe>>;
  let url = "";

  beforeAll(async () => {
    serve = await startServe(
      engineHome.path,
      await freePort(),
      () => new Date("2026-11-04T09:00:00Z"),
    );
    url = serve.url;
  });
  afterAll(async () => {
    await serve.stop();
  });

  const init = (
    sb: ReturnType<typeof sandbox>,
    args: string[],
    io: Parameters<typeof cli>[1] = {},
  ) =>
    cli(["init", ...args, "--home", engineHome.path, "--url", url], {
      env: { HOME: sb.home },
      cwd: sb.repo,
      ...io,
    });
  const projects = async () => {
    const r = await cli(["project", "list", "--json", "--home", engineHome.path, "--url", url], {
      cwd: engineHome.path,
    });
    return (JSON.parse(r.stdout) as { projects: { name: string; roots: string[] }[] }).projects;
  };

  it("adds the Git top-level as a project named after the folder, from a subdirectory", async () => {
    const sb = sandbox();
    const sub = join(sb.repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const r = await init(sb, ["--no-hooks"], { cwd: sub });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("my-app");
    const mine = (await projects()).filter((p) => p.roots.includes(sb.top));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.name).toBe("my-app");
    expect(mine[0]?.roots).toEqual([sb.top]);
  });

  it("--name overrides the folder name", async () => {
    const sb = sandbox();
    const r = await init(sb, ["--name", "Custom Name", "--no-hooks"]);
    expect(r.code).toBe(0);
    const mine = (await projects()).filter((p) => p.roots.includes(sb.top));
    expect(mine.map((p) => p.name)).toEqual(["Custom Name"]);
  });

  it("is idempotent: the second run says it is already set up and adds nothing", async () => {
    const sb = sandbox();
    expect((await init(sb, ["--no-hooks"])).code).toBe(0);
    const again = await init(sb, ["--no-hooks"]);
    expect(again.code).toBe(0);
    expect(again.stdout + again.stderr).toMatch(/already set up/i);
    expect((await projects()).filter((p) => p.roots.includes(sb.top))).toHaveLength(1);
  });

  it("fails outside a Git repository with one clear sentence", async () => {
    const sb = sandbox();
    const plain = join(sb.root, "plain");
    mkdirSync(plain);
    const r = await init(sb, ["--no-hooks"], {
      cwd: plain,
      env: { HOME: sb.home, GIT_CEILING_DIRECTORIES: sb.root },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Git repository/i);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).not.toMatch(/\bat .*\.ts:\d+/);
  });

  it("with --yes installs the project-scope hooks without asking", async () => {
    const sb = sandbox();
    const asked: string[] = [];
    const r = await init(sb, ["--yes"], {
      confirm: async (q) => {
        asked.push(q);
        return false;
      },
    });
    expect(r.code).toBe(0);
    expect(asked).toEqual([]);
    const settings = join(sb.top, ".claude", "settings.local.json");
    expect(existsSync(settings)).toBe(true);
    expect(JSON.stringify(JSON.parse(readFileSync(settings, "utf8")).hooks)).toContain(
      "SessionStart",
    );
    // The diff the install flow shows is part of the output.
    expect(r.stdout).toContain("settings.local.json");
  });

  it("asks once, showing the diff, and writes the hooks when confirmed", async () => {
    const sb = sandbox();
    const asked: string[] = [];
    const r = await init(sb, [], {
      confirm: async (q) => {
        asked.push(q);
        return true;
      },
    });
    expect(r.code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("settings.local.json");
    expect(r.stdout).toContain("SessionStart");
    expect(existsSync(join(sb.top, ".claude", "settings.local.json"))).toBe(true);
  });

  it("declining the hook question still adds the project, exits 0 and says how to install later", async () => {
    const sb = sandbox();
    const r = await init(sb, [], { confirm: async () => false });
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.top, ".claude", "settings.local.json"))).toBe(false);
    expect(r.stdout + r.stderr).toContain("taskville install claude-code");
    expect((await projects()).some((p) => p.roots.includes(sb.top))).toBe(true);
  });

  it("--no-hooks never asks and never writes settings", async () => {
    const sb = sandbox();
    let asked = 0;
    const r = await init(sb, ["--no-hooks"], {
      confirm: async () => {
        asked += 1;
        return true;
      },
    });
    expect(r.code).toBe(0);
    expect(asked).toBe(0);
    expect(existsSync(join(sb.top, ".claude"))).toBe(false);
    expect(existsSync(join(sb.home, ".claude"))).toBe(false);
  });

  it("says so and points at `taskville start` when no engine is running", async () => {
    const sb = sandbox();
    // A home with no token: nothing was ever started there.
    const none = await cli(["init", "--no-hooks", "--home", sb.tv], {
      env: { HOME: sb.home },
      cwd: sb.repo,
    });
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain("taskville start");
    // A token but nothing listening on the port.
    writeFileSync(join(sb.tv, "token"), "t\n", { mode: 0o600 });
    const dead = await cli(
      ["init", "--no-hooks", "--home", sb.tv, "--url", `http://127.0.0.1:${await freePort()}`],
      { env: { HOME: sb.home }, cwd: sb.repo },
    );
    expect(dead.code).not.toBe(0);
    expect(dead.stderr).toContain("taskville start");
  });
});
