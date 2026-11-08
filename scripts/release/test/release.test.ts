import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
  dirty?: boolean;
  environment?: string;
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

/** Any manifest field (other than the file list) whose value, or whose .sha256, is this hash. */
function recordsHash(manifest: Manifest, hash: string): boolean {
  return Object.entries(manifest).some(
    ([key, value]) =>
      key !== "files" &&
      (value === hash ||
        (typeof value === "object" &&
          value !== null &&
          (value as { sha256?: unknown }).sha256 === hash)),
  );
}

function tinyWeb(setup: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(scratch, "web-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div>');
  setup(dir);
  return dir;
}

function extract(tgz: string, into: string): string {
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", into]);
  return join(into, "package");
}

/** Recreates a node_modules tree so workspace links resolve inside the fixture, not the real repo. */
function mirrorModules(real: string, fx: string, tamperLock: boolean): void {
  mkdirSync(fx, { recursive: true });
  for (const entry of readdirSync(real, { withFileTypes: true })) {
    const from = join(real, entry.name);
    const to = join(fx, entry.name);
    if (entry.name === ".pnpm") {
      mkdirSync(to);
      for (const name of readdirSync(from)) {
        if (name !== "lock.yaml") symlinkSync(join(from, name), join(to, name));
      }
      const lock = readFileSync(join(from, "lock.yaml"), "utf8");
      writeFileSync(join(to, "lock.yaml"), tamperLock ? lock.replaceAll("2.6.4", "2.6.5") : lock);
    } else if (entry.name.startsWith(".")) {
    } else if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
    } else if (entry.isDirectory() && entry.name.startsWith("@")) {
      mirrorModules(from, to, false);
    } else if (entry.isDirectory()) {
      symlinkSync(from, to);
    }
  }
}

const fxGit = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd: root,
    encoding: "utf8",
  }).trim();

/**
 * A committed, clean copy of this repository's sources (apps, packages, scripts and the root
 * files) in a temp directory, with node_modules mirrored so a build runs without installing.
 * It is the injectable root for tests that change sources, git history or the lockfile.
 */
function makeFixture(options: { tamperLock?: boolean } = {}): string {
  const root = mkdtempSync(join(scratch, "fx-"));
  const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  })
    .split("\0")
    .filter(Boolean);
  for (const rel of listed) {
    if (rel.includes("/") && !/^(apps|packages|scripts)\//.test(rel)) continue;
    const from = join(ROOT, rel);
    if (!existsSync(from) || !lstatSync(from).isFile()) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(from, join(root, rel));
  }
  mirrorModules(
    join(ROOT, "node_modules"),
    join(root, "node_modules"),
    options.tamperLock === true,
  );
  for (const group of ["apps", "packages", "scripts"]) {
    for (const name of readdirSync(join(ROOT, group))) {
      const modules = join(ROOT, group, name, "node_modules");
      if (existsSync(modules))
        mirrorModules(modules, join(root, group, name, "node_modules"), false);
    }
  }
  fxGit(root, "init", "-q");
  writeFileSync(join(root, ".git", "info", "exclude"), "node_modules\n");
  fxGit(root, "add", "-A");
  fxGit(root, "commit", "-q", "-m", "fixture");
  return root;
}

/** Runs fn with these variables set in this process, restoring them afterwards. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("release build (real repository, shared)", () => {
  let first: Built;
  let second: Built;
  let extracted: string;
  const outA = join(scratch, "out-a");
  const outB = join(scratch, "out-b");

  beforeAll(async () => {
    // Build A goes through the real entry point, build B through the exported function.
    execFileSync(
      process.execPath,
      [MAIN, "--out", outA, "--allow-dirty", "--environment", "staging"],
      {
        cwd: ROOT,
        stdio: "pipe",
        env: { ...process.env, HOME: scratch },
      },
    );
    await buildRelease({ root: ROOT, outDir: outB, allowDirty: true, environment: "staging" });
    first = readBuilt(outA);
    second = readBuilt(outB);
    extracted = join(scratch, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", first.tgz, "-C", extracted]);
  }, SLOW);

  it("contains no absolute path of the build machine in bin/ or web/", () => {
    const packageDir = join(extracted, "package");
    const needles = [...new Set([ROOT, realpathSync(ROOT), homedir(), scratch, "tv-release-"])]
      .filter((n) => n.length > 1)
      .map((n) => n.replace(/\/$/, ""));
    const files = filesUnder(packageDir).filter(
      (p) => p === "bin/taskville.js" || p.startsWith("web/"),
    );
    expect(files).toContain("bin/taskville.js");
    for (const file of files) {
      const text = readFileSync(join(packageDir, file), "latin1");
      for (const needle of needles)
        expect(text.includes(needle), `${file} contains ${needle}`).toBe(false);
    }
  });

  it("ships bin/taskville.js executable (mode 755) and the hook scripts", () => {
    const listing = execFileSync("tar", ["-tvzf", first.tgz], { encoding: "utf8" });
    const line = listing.split("\n").find((l) => l.endsWith("package/bin/taskville.js")) ?? "";
    expect(line.startsWith("-rwxr-xr-x"), line).toBe(true);
    const packageDir = join(extracted, "package");
    for (const hook of ["claude-code-shim.sh", "claude-code-otel-headers.sh"]) {
      expect(existsSync(join(packageDir, "hooks", hook)), hook).toBe(true);
    }
  });

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
    expect(identity).toMatchObject({
      id: first.id,
      version: first.manifest.version,
      commit,
      environment: "staging",
    });
    expect(
      Object.keys(identity).filter(
        (k) => !["id", "version", "commit", "environment", "dirty"].includes(k),
      ),
    ).toEqual([]);
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
    await buildRelease({ root: ROOT, outDir: out, allowDirty: true, environment: "staging" });
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

  async function withEngine(
    extraEnv: Record<string, string>,
    run: (base: string, tokenFile: string) => Promise<void>,
  ): Promise<void> {
    const port = await freePort();
    const env = { ...cleanEnv(home), ...extraEnv };
    const child: ChildProcess = spawn(bin, ["start", "--no-open", "--port", String(port)], {
      env,
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
      await run(base, join(env.TASKVILLE_HOME as string, "token"));
    } finally {
      child.kill("SIGTERM");
    }
  }

  it("the installed engine serves the packaged web client at /", async () => {
    await withEngine({}, async (base) => {
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('id="root"');
    });
  }, 60_000);

  it("ignores an inherited TASKVILLE_WEB_DIR: the packaged client is always served", async () => {
    const decoy = mkdtempSync(join(scratch, "decoy-"));
    writeFileSync(join(decoy, "index.html"), "<html>DECOY-CLIENT</html>");
    await withEngine({ TASKVILLE_WEB_DIR: decoy }, async (base) => {
      const text = await (await fetch(`${base}/`)).text();
      expect(text).not.toContain("DECOY-CLIENT");
      expect(text).toContain('id="root"');
    });
  }, 60_000);

  it("authenticated /health reports this release's id and environment", async () => {
    await withEngine({}, async (base, tokenFile) => {
      const token = readFileSync(tokenFile, "utf8").trim();
      const res = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        release: { id: string; version: string; environment: string };
      };
      expect(body.release.id).toBe(built.id);
      expect(body.release.version).toBe(built.manifest.version);
      expect(body.release.environment).toBe("staging");
    });
  }, 60_000);

  it("`install claude-code --dry-run` from the installed package names the packaged shim", () => {
    const project = mkdtempSync(join(scratch, "project-"));
    const out = execFileSync(
      bin,
      ["install", "claude-code", "--scope", "project", "--project-dir", project, "--dry-run"],
      { env: cleanEnv(home), encoding: "utf8" },
    );
    expect(out).toContain("taskville-claude-code-shim.sh");
    expect(existsSync(join(project, ".claude"))).toBe(false);
  });
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
      await expect(
        buildRelease({ root: ROOT, outDir, allowDirty: true, environment: "staging", webDir }),
      ).rejects.toThrow(/secrets file/i);
      for (const name of [".env", ".dev.vars"]) {
        const dir = webDirWith((d) => writeFileSync(join(d, name), "SECRET=1"));
        await expect(
          buildRelease({
            root: ROOT,
            outDir: join(scratch, `out-${name}`),
            allowDirty: true,
            environment: "staging",
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
      await expect(
        buildRelease({ root: ROOT, outDir, allowDirty: true, environment: "staging", webDir }),
      ).rejects.toThrow(/symlink/i);
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

describe("identity and lockfile (fixture repository)", () => {
  let root: string;
  let clean1: Built;
  let clean2: Built;
  let dirty: Built;
  let dirtyLock: Built;
  let lockHash: string;
  const web = () => tinyWeb();
  const outFor = (name: string) => join(scratch, `out-id-${name}`);

  beforeAll(async () => {
    root = makeFixture();
    lockHash = sha256(readFileSync(join(root, "pnpm-lock.yaml")));
    await buildRelease({ root, outDir: outFor("c1"), webDir: web() });
    clean1 = readBuilt(outFor("c1"));
    // M7.31: a clean build with no environment option defaults to production.
    expect(JSON.parse(clean1.releaseJson).environment).toBe("production");
    // Same tree, new commit: the content is identical, only the commit differs.
    fxGit(root, "commit", "-q", "--allow-empty", "-m", "second commit, same content");
    await buildRelease({ root, outDir: outFor("c2"), webDir: web() });
    clean2 = readBuilt(outFor("c2"));
    // Same HEAD, untracked file: the packaged content is identical, only the dirty flag differs.
    writeFileSync(join(root, "scratch-notes.txt"), "uncommitted");
    await buildRelease({
      root,
      outDir: outFor("d1"),
      webDir: web(),
      allowDirty: true,
      environment: "staging",
    });
    dirty = readBuilt(outFor("d1"));
    // Same HEAD and dirty, but the lockfile differs (a comment, so the resolved versions are equal).
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      `${readFileSync(join(root, "pnpm-lock.yaml"), "utf8")}# touched\n`,
    );
    await buildRelease({
      root,
      outDir: outFor("d2"),
      webDir: web(),
      allowDirty: true,
      environment: "staging",
    });
    dirtyLock = readBuilt(outFor("d2"));
  }, SLOW);

  it("a fixture repository builds (the helper itself works)", () => {
    expect(clean1.id).toMatch(/^[a-f0-9]{16}$/);
  });

  it("two commits with identical content get different ids", () => {
    expect(clean2.manifest.commit).not.toBe(clean1.manifest.commit);
    expect(clean2.manifest.digest).not.toBe(clean1.manifest.digest);
    expect(clean2.id).not.toBe(clean1.id);
  });

  it("a dirty build records dirty: true and gets a different id from the clean build of the same HEAD", () => {
    expect(dirty.manifest.commit).toBe(clean2.manifest.commit);
    expect(JSON.parse(dirty.releaseJson)).toMatchObject({ dirty: true });
    expect(dirty.manifest.dirty).toBe(true);
    expect(JSON.parse(clean2.releaseJson).dirty).not.toBe(true);
    expect(clean2.manifest.dirty).not.toBe(true);
    expect(dirty.id).not.toBe(clean2.id);
  });

  it("the manifest records release.json's sha256 as its own field", () => {
    for (const b of [clean1, clean2, dirty]) {
      expect(recordsHash(b.manifest, sha256(b.releaseJson))).toBe(true);
    }
  });

  it("the manifest records pnpm-lock.yaml's sha256, and it is part of the digest", () => {
    expect(recordsHash(clean1.manifest, lockHash)).toBe(true);
    expect(dirtyLock.manifest.commit).toBe(dirty.manifest.commit);
    expect(
      recordsHash(dirtyLock.manifest, sha256(readFileSync(join(root, "pnpm-lock.yaml")))),
    ).toBe(true);
    expect(dirtyLock.id).not.toBe(dirty.id);
  });

  it("refuses to write into <id>/ when it already holds a different tarball", async () => {
    const out = outFor("collide");
    const clean = makeFixture();
    const again = () => buildRelease({ root: clean, outDir: out, webDir: web() });
    await again();
    const built = readBuilt(out);
    await again(); // identical bytes into the same place are fine
    writeFileSync(built.tgz, "not the reviewed tarball");
    await expect(again()).rejects.toThrow(/already|differ|exists/i);
    expect(readFileSync(built.tgz, "utf8")).toBe("not the reviewed tarball");
  });
});

describe("lockfile guard (fixture repository)", () => {
  it(
    "refuses a build when node_modules/.pnpm/lock.yaml differs from pnpm-lock.yaml",
    async () => {
      const root = makeFixture({ tamperLock: true });
      const outDir = join(scratch, "out-lock-mismatch");
      await expect(buildRelease({ root, outDir, webDir: tinyWeb() })).rejects.toThrow(
        /lock\.yaml|lockfile|pnpm-lock/i,
      );
      expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
    },
    SLOW,
  );
});

describe("secrets scan over the staged tree", () => {
  it.each([
    ".npmrc",
    ".netrc",
    "server.pem",
    "tls.key",
    "id_rsa",
    "id_ed25519.pub",
    "credentials.json",
    ".dev.vars.staging",
  ])(
    "refuses %s in the artifact",
    async (name) => {
      const webDir = tinyWeb((dir) => writeFileSync(join(dir, name), "secret"));
      await expect(
        buildRelease({
          root: ROOT,
          outDir: join(scratch, `out-sec-${name}`),
          allowDirty: true,
          environment: "staging",
          webDir,
        }),
      ).rejects.toThrow(/secrets file/i);
    },
    SLOW,
  );

  it(
    "refuses a secrets file that is tracked under apps/cli/hooks (the scan covers every staged file)",
    async () => {
      const root = makeFixture();
      writeFileSync(join(root, "apps/cli/hooks/id_rsa"), "private");
      fxGit(root, "add", "-f", "apps/cli/hooks/id_rsa");
      fxGit(root, "commit", "-q", "-m", "oops");
      await expect(
        buildRelease({ root, outDir: join(scratch, "out-sec-hooks"), webDir: tinyWeb() }),
      ).rejects.toThrow(/secrets file/i);
    },
    SLOW,
  );

  it(
    "never ships an untracked file from apps/cli/hooks (only the tracked scripts are copied)",
    async () => {
      const root = makeFixture();
      writeFileSync(join(root, "apps/cli/hooks/notes.txt"), "stray notes");
      writeFileSync(join(root, "apps/cli/hooks/credentials.json"), "{}");
      const outDir = join(scratch, "out-untracked-hook");
      // Refusing and not shipping are both safe; shipping is the failure.
      await buildRelease({
        root,
        outDir,
        webDir: tinyWeb(),
        allowDirty: true,
        environment: "staging",
      }).catch(() => undefined);
      const tarballs = existsSync(outDir)
        ? readdirSync(outDir).flatMap((id) =>
            readdirSync(join(outDir, id))
              .filter((n) => n.endsWith(".tgz"))
              .map((n) => join(outDir, id, n)),
          )
        : [];
      for (const tgz of tarballs) {
        const listing = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" });
        expect(listing).not.toContain("notes.txt");
        expect(listing).not.toContain("credentials.json");
        expect(listing).toContain("package/hooks/claude-code-shim.sh");
      }
    },
    SLOW,
  );
});

describe("clean build environment", () => {
  it(
    "the web build sees no VITE_* variables from the caller's environment or apps/web/.env* files",
    async () => {
      const root = makeFixture();
      const marker = {
        env: "env-marker-2b9f41",
        file: "file-marker-5c1e07",
        prod: "prod-file-marker-77aa30",
      };
      writeFileSync(
        join(root, "apps/web/src/release-probe.ts"),
        `console.log("taskville-probe", import.meta.env.VITE_TV_PROBE_ENV, import.meta.env.VITE_TV_PROBE_FILE, import.meta.env.VITE_TV_PROBE_PROD, import.meta.env.VITE_TV_TEST_HOOKS);\n`,
      );
      const entry = join(root, "apps/web/src/main.tsx");
      writeFileSync(entry, `import "./release-probe.ts";\n${readFileSync(entry, "utf8")}`);
      writeFileSync(join(root, "apps/web/.env"), `VITE_TV_PROBE_FILE=${marker.file}\n`);
      writeFileSync(join(root, "apps/web/.env.production"), `VITE_TV_PROBE_PROD=${marker.prod}\n`);
      const outDir = join(scratch, "out-clean-env");
      await withEnv({ VITE_TV_PROBE_ENV: marker.env, VITE_TV_TEST_HOOKS: "1" }, () =>
        buildRelease({ root, outDir, allowDirty: true, environment: "staging" }),
      );
      const web = join(extract(readBuilt(outDir).tgz, join(scratch, "x-clean-env")), "web");
      const bundled = filesUnder(web)
        .filter((p) => /\.(js|html|css)$/.test(p))
        .map((p) => readFileSync(join(web, p), "utf8"))
        .join("\n");
      // The probe made it into the client, and none of the caller's values did.
      expect(bundled.includes("taskville-probe"), "probe is in the client").toBe(true);
      for (const value of Object.values(marker)) expect(bundled.includes(value), value).toBe(false);
    },
    SLOW,
  );
});

describe("bundle guard", () => {
  it(
    "fails when a workspace module outside the allowlist contains import.meta.url",
    async () => {
      const root = makeFixture();
      writeFileSync(
        join(root, "apps/cli/src/where-am-i.ts"),
        "export const where = import.meta.url;\n",
      );
      const main = join(root, "apps/cli/src/main.ts");
      writeFileSync(
        main,
        `${readFileSync(main, "utf8")}\nimport { where } from "./where-am-i.ts";\nObject.assign(globalThis, { tvWhere: where });\n`,
      );
      await expect(
        buildRelease({
          root,
          outDir: join(scratch, "out-guard"),
          webDir: tinyWeb(),
          allowDirty: true,
          environment: "staging",
        }),
      ).rejects.toThrow(/import\.meta\.url/);
    },
    SLOW,
  );
});

describe("environment option", () => {
  it(
    "rejects an environment outside development|staging|production",
    async () => {
      for (const environment of ["qa", "Production", ""]) {
        await expect(
          buildRelease({
            root: ROOT,
            outDir: join(scratch, `out-env-${environment || "empty"}`),
            allowDirty: true,
            webDir: tinyWeb(),
            environment,
          }),
        ).rejects.toThrow(/environment/i);
      }
    },
    SLOW,
  );

  it(
    "accepts development and staging and records them in release.json",
    async () => {
      for (const environment of ["development", "staging"]) {
        const outDir = join(scratch, `out-env-ok-${environment}`);
        await buildRelease({
          root: ROOT,
          outDir,
          allowDirty: true,
          webDir: tinyWeb(),
          environment,
        });
        expect(JSON.parse(readBuilt(outDir).releaseJson)).toMatchObject({ environment });
      }
    },
    SLOW,
  );

  it(
    "main.ts rejects an unknown --environment with a non-zero exit",
    () => {
      let status = 0;
      let stderr = "";
      try {
        execFileSync(
          process.execPath,
          [MAIN, "--out", join(scratch, "out-env-cli"), "--allow-dirty", "--environment", "qa"],
          { stdio: "pipe", env: { ...process.env, HOME: scratch } },
        );
      } catch (error) {
        const e = error as { status: number; stderr: Buffer };
        status = e.status;
        stderr = e.stderr.toString();
      }
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/environment/i);
    },
    SLOW,
  );
});

describe("tar paths", () => {
  const build = (name: string, setup: (dir: string) => void) =>
    buildRelease({
      root: ROOT,
      outDir: join(scratch, `out-tar-${name}`),
      allowDirty: true,
      environment: "staging",
      webDir: tinyWeb(setup),
    });

  it(
    "packs a long ASCII path (over 100 bytes) so tar extracts it intact",
    async () => {
      const parts = ["a".repeat(60), "b".repeat(60)];
      await build("long-ascii", (dir) => {
        mkdirSync(join(dir, ...parts), { recursive: true });
        writeFileSync(join(dir, ...parts, "file.txt"), "long path contents");
      });
      const built = readBuilt(join(scratch, "out-tar-long-ascii"));
      const packageDir = extract(built.tgz, join(scratch, "x-tar-long-ascii"));
      expect(readFileSync(join(packageDir, "web", ...parts, "file.txt"), "utf8")).toBe(
        "long path contents",
      );
    },
    SLOW,
  );

  it.each([
    [
      "a directory of 90 two-byte characters",
      (dir: string) => {
        mkdirSync(join(dir, "é".repeat(90)));
        writeFileSync(join(dir, "é".repeat(90), "x.txt"), "x");
      },
    ],
    [
      "a file name of 106 bytes",
      (dir: string) => writeFileSync(join(dir, `${"é".repeat(51)}.txt`), "x"),
    ],
  ])(
    "refuses a non-ASCII path too long for a ustar header: %s",
    async (label, setup) => {
      await expect(build(`non-ascii-${label.length}`, setup)).rejects.toThrow(/long/i);
    },
    SLOW,
  );
});

describe("builds from another cwd and with --environment (real repository)", () => {
  let first: Built;
  let otherCwd: Built;
  let staging: Built;
  const run = (cwd: string, out: string, environment: string) =>
    execFileSync(
      process.execPath,
      [MAIN, "--out", out, "--allow-dirty", "--environment", environment],
      {
        cwd,
        stdio: "pipe",
        env: { ...process.env, HOME: scratch },
      },
    );

  beforeAll(() => {
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(elsewhere);
    run(ROOT, join(scratch, "out-e-base"), "development");
    run(elsewhere, join(scratch, "out-e-cwd"), "development");
    first = readBuilt(join(scratch, "out-e-base"));
    otherCwd = readBuilt(join(scratch, "out-e-cwd"));
  }, SLOW);

  it("is byte-identical when the build starts from a different process cwd", () => {
    expect(otherCwd.id).toBe(first.id);
    expect(sha256(readFileSync(otherCwd.tgz))).toBe(sha256(readFileSync(first.tgz)));
  });

  it("main.ts accepts --environment and records it, with a different id", () => {
    run(ROOT, join(scratch, "out-e-staging"), "staging");
    staging = readBuilt(join(scratch, "out-e-staging"));
    expect(JSON.parse(staging.releaseJson)).toMatchObject({ environment: "staging" });
    expect(staging.manifest.environment ?? JSON.parse(staging.releaseJson).environment).toBe(
      "staging",
    );
    expect(staging.id).not.toBe(first.id);
  });
});
