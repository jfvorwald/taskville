import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRelease } from "../src/release.ts";

// M7.02 (#83): release packaging with release identity. Red-phase tests.
//
// Contract under test (docs/spikes/S-3-staging.md option C; reference: jaqstudios/scripts/release.mjs):
//   scripts/release/src/release.ts exports
//     buildRelease(options: { root: string; outDir: string; allowDirty?: boolean;
//                             webDir?: string; environment?: string }): Promise<unknown>
//   scripts/release/src/main.ts is the thin entry: `node scripts/release/src/main.ts --out <dir>
//   [--allow-dirty]`, wired as the root package.json "release" script.
//   A build writes <outDir>/<releaseId>/ holding exactly: taskville-<version>.tgz, release.json,
//   manifest.json. The tarball is one self-contained npm package ("package/" prefix) with a
//   `taskville` bin written in JavaScript, no runtime dependencies, the built web client where the
//   installed engine resolves index.html, and release.json { id, version, commit, environment } at
//   the package root. The manifest lists every packaged file with size and sha256, plus the
//   tarball's sha256. The release id is the first 16 hex chars of the manifest digest and depends
//   on content only. A dirty working tree is refused unless allowDirty; symlinks and local secrets
//   files (.env*, .dev.vars*) in the artifact are refused.
//
//   Test seam (a decision for the implementer to confirm): `webDir` is a prebuilt web client to
//   package instead of running the vite build. Used only by the refusal tests, which plant a
//   forbidden file in it. Every other test builds the real client.
//
// The real build is slow (vite). Two builds are shared by the whole file via beforeAll. These tests
// are NOT in the root vitest projects (vitest.config.ts); run them with the command in the
// handoff.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAIN = join(ROOT, "scripts/release/src/main.ts");
const SLOW = 600_000;

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function filesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), name));
    else out.push(name);
  }
  return out.sort();
}

function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

interface Manifest {
  format: number;
  id: string;
  digest: string;
  version: string;
  commit: string;
  files: { path: string; size: number; sha256: string }[];
  tarball: { sha256: string };
}

interface Built {
  dir: string;
  id: string;
  tgz: string;
  manifest: Manifest;
  releaseJson: string;
}

function readBuilt(outDir: string): Built {
  const id = only(readdirSync(outDir));
  const dir = join(outDir, id);
  const tgz = only(readdirSync(dir).filter((n) => n.endsWith(".tgz")));
  return {
    dir,
    id,
    tgz: join(dir, tgz),
    manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest,
    releaseJson: readFileSync(join(dir, "release.json"), "utf8"),
  };
}

const scratch = mkdtempSync(join(tmpdir(), "tv-release-test-"));
const cleanEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  TASKVILLE_HOME: join(home, "taskville-home"),
  npm_config_cache: join(home, "npm-cache"),
  npm_config_update_notifier: "false",
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("release build (real repository, shared)", () => {
  let first: Built;
  let second: Built;
  let extracted: string;
  const outA = join(scratch, "out-a");
  const outB = join(scratch, "out-b");

  beforeAll(async () => {
    // Build A goes through the real entry point, build B through the exported function.
    execFileSync(process.execPath, [MAIN, "--out", outA, "--allow-dirty"], {
      cwd: ROOT,
      stdio: "pipe",
      env: { ...process.env, HOME: scratch },
    });
    await buildRelease({ root: ROOT, outDir: outB, allowDirty: true });
    first = readBuilt(outA);
    second = readBuilt(outB);
    extracted = join(scratch, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", first.tgz, "-C", extracted]);
  }, SLOW);

  it("writes <outDir>/<releaseId>/ with the tarball, release.json and manifest.json", () => {
    const names = readdirSync(first.dir).sort();
    expect(names).toHaveLength(3);
    expect(names).toContain("release.json");
    expect(names).toContain("manifest.json");
    expect(names.find((n) => n.endsWith(".tgz"))).toBe(`taskville-${first.manifest.version}.tgz`);
    expect(first.id).toMatch(/^[a-f0-9]{16}$/);
  });

  it("is reproducible: same commit, different out dirs, identical tarball and id", () => {
    expect(second.id).toBe(first.id);
    expect(sha256(readFileSync(second.tgz))).toBe(sha256(readFileSync(first.tgz)));
    expect(second.releaseJson).toBe(first.releaseJson);
    expect(second.manifest).toEqual(first.manifest);
  });

  it("derives the release id from a digest of content, not from time", () => {
    const { manifest, id } = first;
    expect(manifest.format).toBe(1);
    expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.id).toBe(id);
    expect(manifest.digest.startsWith(id)).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("records release identity in release.json, inside the tarball and alongside it", () => {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    const identity = JSON.parse(first.releaseJson) as Record<string, string>;
    expect(identity).toEqual({
      id: first.id,
      version: first.manifest.version,
      commit,
      environment: "production",
    });
    expect(first.manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(first.manifest.commit).toBe(commit);
    const inside = readFileSync(join(extracted, "package", "release.json"), "utf8");
    expect(inside).toBe(first.releaseJson);
  });

  it("manifest lists every packaged file with size and sha256, and the tarball sha256", () => {
    const packageDir = join(extracted, "package");
    const actual = filesUnder(packageDir);
    const listed = first.manifest.files.map((f) => f.path.replace(/^package\//, ""));
    // release.json carries the id, which is derived from the other files, so the manifest may omit it.
    const withoutIdentity = actual.filter((p) => p !== "release.json");
    expect([...listed].sort()).toEqual(listed.includes("release.json") ? actual : withoutIdentity);
    for (const entry of first.manifest.files) {
      const path = join(packageDir, entry.path.replace(/^package\//, ""));
      const bytes = readFileSync(path);
      expect(entry.size, entry.path).toBe(bytes.length);
      expect(entry.sha256, entry.path).toBe(sha256(bytes));
    }
    expect(first.manifest.tarball.sha256).toBe(sha256(readFileSync(first.tgz)));
  });

  it("packs one self-contained package: JavaScript bin, no dependencies, no TypeScript, no secrets", () => {
    const packageDir = join(extracted, "package");
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(pkg.name).toBe("taskville");
    expect(pkg.version).toBe(first.manifest.version);
    expect(pkg.type).toBe("module");
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "bundleDependencies",
    ]) {
      const value = pkg[field];
      expect(value === undefined || Object.keys(value as object).length === 0, field).toBe(true);
    }
    const bin = (pkg.bin as Record<string, string>).taskville;
    expect(bin).toMatch(/\.(c|m)?js$/);
    expect(existsSync(join(packageDir, bin as string))).toBe(true);
    const all = filesUnder(packageDir);
    expect(all.filter((p) => /\.(ts|tsx|mts|cts)$/.test(p) && !p.endsWith(".d.ts"))).toEqual([]);
    expect(all.filter((p) => /(^|\/)(\.env|\.dev\.vars)/.test(p))).toEqual([]);
    expect(all.some((p) => p.endsWith("index.html"))).toBe(true);
  });
});

describe("installing the tarball", () => {
  let bin: string;
  let built: Built;
  let home: string;

  beforeAll(async () => {
    home = join(scratch, "install-home");
    mkdirSync(home);
    const out = join(scratch, "out-install");
    await buildRelease({ root: ROOT, outDir: out, allowDirty: true });
    built = readBuilt(out);
    const prefix = join(scratch, "prefix");
    mkdirSync(prefix);
    execFileSync(
      "npm",
      ["install", "--prefix", prefix, built.tgz, "--offline", "--no-audit", "--no-fund"],
      { env: cleanEnv(home), stdio: "pipe" },
    );
    bin = join(prefix, "node_modules", ".bin", "taskville");
  }, SLOW);

  it("installs offline and `taskville --version` prints the version and release id", () => {
    const out = execFileSync(bin, ["--version"], { env: cleanEnv(home), encoding: "utf8" });
    expect(out).toContain(built.manifest.version);
    expect(out).toContain(built.id);
  });

  it("the installed engine serves the packaged web client at /", async () => {
    const port = await freePort();
    const child: ChildProcess = spawn(bin, ["start", "--no-open", "--port", String(port)], {
      env: cleanEnv(home),
      stdio: "ignore",
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        if (child.exitCode !== null) break;
        // /health needs read scope, so an unauthenticated 401 still means the engine is up.
        ready = await fetch(`${base}/health`).then(
          () => true,
          () => false,
        );
        if (!ready) await new Promise((r) => setTimeout(r, 300));
      }
      expect(ready, "installed engine never started answering").toBe(true);
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('id="root"');
    } finally {
      child.kill("SIGTERM");
    }
  }, 60_000);
});

describe("refusals", () => {
  function webDirWith(setup: (dir: string) => void): string {
    const dir = mkdtempSync(join(scratch, "web-"));
    writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div>');
    setup(dir);
    return dir;
  }

  it("refuses a dirty working tree for a real release, before writing anything", async () => {
    const root = mkdtempSync(join(scratch, "repo-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
    git("init", "-q");
    writeFileSync(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}');
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(root, "uncommitted.txt"), "dirty");
    const outDir = join(scratch, "out-dirty");
    await expect(buildRelease({ root, outDir })).rejects.toThrow(/dirty|uncommitted/i);
    expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
  });

  it(
    "refuses a local secrets file in the artifact",
    async () => {
      const webDir = webDirWith((dir) => writeFileSync(join(dir, ".env.production"), "SECRET=1"));
      const outDir = join(scratch, "out-secret");
      await expect(buildRelease({ root: ROOT, outDir, allowDirty: true, webDir })).rejects.toThrow(
        /secrets file/i,
      );
      for (const name of [".env", ".dev.vars"]) {
        const dir = webDirWith((d) => writeFileSync(join(d, name), "SECRET=1"));
        await expect(
          buildRelease({
            root: ROOT,
            outDir: join(scratch, `out-${name}`),
            allowDirty: true,
            webDir: dir,
          }),
        ).rejects.toThrow(/secrets file/i);
      }
    },
    SLOW,
  );

  it(
    "refuses a symlink in the artifact",
    async () => {
      const webDir = webDirWith((dir) =>
        symlinkSync(join(dir, "index.html"), join(dir, "linked.html")),
      );
      const outDir = join(scratch, "out-symlink");
      await expect(buildRelease({ root: ROOT, outDir, allowDirty: true, webDir })).rejects.toThrow(
        /symlink/i,
      );
      expect(relative(scratch, outDir)).toBeTruthy();
      expect(statSync(webDir).isDirectory()).toBe(true);
    },
    SLOW,
  );

  it("the entry point exits non-zero with a usage line when --out is missing", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [MAIN], {
        stdio: "pipe",
        env: { ...process.env, HOME: scratch },
      });
    } catch (error) {
      const e = error as { status: number; stderr: Buffer };
      status = e.status;
      stderr = e.stderr.toString();
    }
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/Usage:.*--out/);
  });
});
