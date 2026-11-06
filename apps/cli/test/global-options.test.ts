import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cli, tempDir } from "./helpers.ts";

// M7.18 (#399): global options (--home, --url, --json) are accepted before or after the command
// name. Red-phase tests: today a leading option makes main.ts print the bare usage and exit 1.

const URL_OK = "http://127.0.0.1:4999";
// Differs from the discovered engine URL, so a test passes only if the explicit --url wins.
const URL_EXPLICIT = "http://127.0.0.1:4888";
const dirs: { remove: () => void }[] = [];
afterAll(() => {
  for (const d of dirs) d.remove();
});

function sandbox() {
  const dir = tempDir("taskville-global-opts-");
  dirs.push(dir);
  const root = realpathSync(dir.path);
  const tv = join(root, "home", ".taskville");
  const project = join(root, "project");
  mkdirSync(tv, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(tv, "engine.json"),
    JSON.stringify({ url: URL_OK, pid: 4242, startedAt: "2026-11-04T10:00:00.000Z" }),
  );
  const probed: string[] = [];
  const run = (argv: string[]) =>
    cli(argv, {
      env: { HOME: join(root, "home") },
      cwd: project,
      isAlive: (pid: number) => pid === 4242,
      doctor: {
        nodeVersion: "26.8.2",
        webClientBuilt: () => true,
        engineHealthy: async (url: string) => {
          probed.push(url);
          return true;
        },
        onPath: () => true,
        listProjects: async () => [{ id: "p1", name: "project", roots: [project] }],
      },
    } as Parameters<typeof cli>[1]);
  return { tv, run, probed, root, project };
}

describe("global options before or after the command name", () => {
  it("--home: doctor reads the named home in either order", async () => {
    const sb = sandbox();
    const after = await sb.run(["doctor", "--home", sb.tv]);
    const before = await sb.run(["--home", sb.tv, "doctor"]);
    expect(after.stdout).toContain(URL_OK);
    expect(before.stderr).not.toContain("Usage:");
    expect(before.stdout).toBe(after.stdout);
    expect(before.code).toBe(after.code);
  });

  it("--json: doctor prints a JSON array in either order", async () => {
    const sb = sandbox();
    const after = await sb.run(["doctor", "--json", "--home", sb.tv]);
    const before = await sb.run(["--json", "doctor", "--home", sb.tv]);
    expect(Array.isArray(JSON.parse(after.stdout))).toBe(true);
    expect(before.stderr).not.toContain("Usage:");
    expect(JSON.parse(before.stdout)).toEqual(JSON.parse(after.stdout));
    expect(before.code).toBe(after.code);
  });

  it("--home and --json together, both before the command", async () => {
    const sb = sandbox();
    const after = await sb.run(["doctor", "--json", "--home", sb.tv]);
    const before = await sb.run(["--home", sb.tv, "--json", "doctor"]);
    expect(before.stderr).not.toContain("Usage:");
    expect(JSON.parse(before.stdout)).toEqual(JSON.parse(after.stdout));
  });

  it("--url: an explicit URL, different from the discovered one, is probed in either order", async () => {
    const sb = sandbox();
    const after = await sb.run(["doctor", "--home", sb.tv, "--url", URL_EXPLICIT]);
    const afterProbed = [...sb.probed];
    sb.probed.length = 0;
    const before = await sb.run(["--url", URL_EXPLICIT, "--home", sb.tv, "doctor"]);
    expect(before.stderr).not.toContain("Usage:");
    expect(afterProbed).toEqual([URL_EXPLICIT]);
    expect(sb.probed).toEqual([URL_EXPLICIT]);
    expect(after.stdout).toContain(URL_EXPLICIT);
    expect(before.stdout).toBe(after.stdout);
    expect(before.stdout).not.toContain(URL_OK);
  });

  it("an unknown command is still rejected after leading options", async () => {
    const sb = sandbox();
    const r = await sb.run(["--home", sb.tv, "nonesuch"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Unknown command "nonesuch"');
  });
});

// roborev 7116: commands with a subcommand or a positional target read it as the first argument,
// so leading globals must not land in front of it.
describe("leading globals with subcommands and targets", () => {
  const REJECTED =
    /Unknown (project|events|demo) command|unknown or missing target|Unknown command/;

  async function same(sb: ReturnType<typeof sandbox>, command: string[], tail: string[]) {
    const after = await sb.run([...command, ...tail]);
    const before = await sb.run([...tail, ...command]);
    expect(before.stderr).not.toMatch(REJECTED);
    expect(before.stderr).not.toContain("Usage: taskville <command>");
    expect(before.stdout).toBe(after.stdout);
    expect(before.stderr).toBe(after.stderr);
    expect(before.code).toBe(after.code);
    return { before, after };
  }

  it("project list: --json before the command is not read as the subcommand", async () => {
    const sb = sandbox();
    await same(sb, ["project", "list"], ["--json", "--home", sb.tv, "--url", URL_EXPLICIT]);
  });

  it("project add: leading globals do not hide the subcommand", async () => {
    const sb = sandbox();
    const lead = ["--home", sb.tv, "--url", URL_EXPLICIT];
    const r = await sb.run([...lead, "project", "add", "--name", "x"]);
    expect(r.stderr).not.toMatch(REJECTED);
  });

  it("events ingest and follow: leading globals do not hide the subcommand", async () => {
    const sb = sandbox();
    const file = join(sb.root, "none.jsonl");
    const tail = ["--json", "--home", sb.tv, "--url", URL_EXPLICIT];
    await same(sb, ["events", "ingest", "--file", file], tail);
    const follow = await sb.run([...tail, "events", "follow", "--project", "p1"]);
    expect(follow.stderr).not.toMatch(REJECTED);
  });

  it("demo run --offline: leading --json applies and the subcommand is honored", async () => {
    const sb = sandbox();
    const command = ["demo", "run", "--offline", "--seed", "42", "--duration", "30m"];
    const { before } = await same(sb, command, ["--json", "--home", sb.tv]);
    expect(JSON.parse(before.stdout)).toMatchObject({ seed: 42 });
  });

  it("demo start: an explicit subcommand after leading globals is not treated as options", async () => {
    const sb = sandbox();
    const r = await sb.run(["--json", "--home", sb.tv, "demo", "start", "--project", "nope"]);
    expect(r.stderr).not.toMatch(REJECTED);
    // `demo start` was read as the subcommand: no "unrecognized argument start" style error.
    expect(r.stderr).not.toMatch(/Unexpected argument|Unknown option|unrecognized/i);
  });

  for (const verb of ["install", "uninstall"]) {
    it(`${verb} claude-code: leading globals do not hide the target`, async () => {
      const sb = sandbox();
      const command = [
        verb,
        "claude-code",
        "--scope",
        "project",
        "--project-dir",
        sb.project,
        "--dry-run",
      ];
      const tail = ["--home", sb.tv, "--url", URL_EXPLICIT];
      const { before } = await same(sb, command, tail);
      expect(before.stderr).not.toContain("unknown or missing target");
    });
  }
});
