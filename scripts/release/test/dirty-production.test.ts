import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRelease } from "../src/release.ts";

// M7.31 (#435, M7.06 L2). A dirty working tree plus `--allow-dirty` yields a production-looking
// release whose commit does not describe its contents. Production never accepts a dirty tree, with
// or without --allow-dirty; development and staging still may. The refusal happens before anything
// is written. Fixture repositories only: the refusal comes before any bundling, so these are fast.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tv-release-dirty-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function dirtyFixture(): string {
  const root = mkdtempSync(join(scratch, "repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q");
  writeFileSync(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}');
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(root, "uncommitted.txt"), "dirty");
  return root;
}

function written(outDir: string): string[] {
  return existsSync(outDir) ? readdirSync(outDir) : [];
}

describe("dirty production build", () => {
  it("is refused with allowDirty and an explicit production environment, writing nothing", async () => {
    const root = dirtyFixture();
    const outDir = join(scratch, "out-explicit");
    await expect(
      buildRelease({ root, outDir, allowDirty: true, environment: "production" }),
    ).rejects.toThrow(/production/i);
    expect(written(outDir)).toEqual([]);
  });

  it("is refused with allowDirty and the default environment (production), writing nothing", async () => {
    const root = dirtyFixture();
    const outDir = join(scratch, "out-default");
    await expect(buildRelease({ root, outDir, allowDirty: true })).rejects.toThrow(/production/i);
    expect(written(outDir)).toEqual([]);
  });

  it("`pnpm release --allow-dirty --environment production` exits non-zero with a clear error and writes nothing", () => {
    // Run the real entry point from a fixture repository laid out like the real one: main.ts
    // resolves its root three directories up from itself.
    const root = dirtyFixture();
    const src = join(root, "scripts/release/src");
    mkdirSync(src, { recursive: true });
    cpSync(SRC, src, { recursive: true });
    const outDir = join(scratch, "out-cli");
    const result = spawnSync(
      process.execPath,
      [join(src, "main.ts"), "--out", outDir, "--allow-dirty", "--environment", "production"],
      { cwd: root, encoding: "utf8", env: { ...process.env, HOME: scratch } },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/production/i);
    expect(result.stderr).toMatch(/dirty|uncommitted/i);
    expect(written(outDir)).toEqual([]);
  });
});
