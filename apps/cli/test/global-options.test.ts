import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cli, tempDir } from "./helpers.ts";

// M7.18 (#399): global options (--home, --url, --json) are accepted before or after the command
// name. Red-phase tests: today a leading option makes main.ts print the bare usage and exit 1.

const URL_OK = "http://127.0.0.1:4999";
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
  const run = (argv: string[]) =>
    cli(argv, {
      env: { HOME: join(root, "home") },
      cwd: project,
      isAlive: (pid: number) => pid === 4242,
      doctor: {
        nodeVersion: "26.8.2",
        webClientBuilt: () => true,
        engineHealthy: async () => true,
        onPath: () => true,
        listProjects: async () => [{ id: "p1", name: "project", roots: [project] }],
      },
    } as Parameters<typeof cli>[1]);
  return { tv, run };
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

  it("--url: a leading --url is accepted too", async () => {
    const sb = sandbox();
    const after = await sb.run(["doctor", "--home", sb.tv, "--url", URL_OK]);
    const before = await sb.run(["--url", URL_OK, "--home", sb.tv, "doctor"]);
    expect(before.stderr).not.toContain("Usage:");
    expect(before.stdout).toBe(after.stdout);
  });

  it("an unknown command is still rejected after leading options", async () => {
    const sb = sandbox();
    const r = await sb.run(["--home", sb.tv, "nonesuch"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Unknown command "nonesuch"');
  });
});
