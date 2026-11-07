// Release packaging (M7.02, #83): one installable tarball with a release identity and a manifest.
// Shape follows docs/spikes/S-3-staging.md option C and jaqstudios/scripts/release.mjs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export interface BuildOptions {
  /** The repository to package. */
  root: string;
  /** Where `<releaseId>/` is written. */
  outDir: string;
  /** Package a tree with uncommitted changes (never for a real release). */
  allowDirty?: boolean;
  /** A prebuilt web client to package instead of running the vite build. */
  webDir?: string;
  /** Recorded in release.json and shown by the UI; defaults to "production". */
  environment?: string;
}

export interface Release {
  id: string;
  version: string;
  directory: string;
}

interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}

/** Fixed so the tarball bytes depend on content only (the date npm uses for packed files). */
const TAR_MTIME = 499162500;

/**
 * The bundle runs from `<package>/bin/`, not from the source tree, so the few paths the sources
 * compute from `import.meta.url` are pointed at the package layout. A rewrite that no longer
 * matches fails the build instead of shipping a package that cannot find its own files.
 */
const PATH_REWRITES = [
  { file: "apps/engine/src/config/web-dir.ts", from: '"../../../web/dist"', to: '"../web"' },
  { file: "apps/cli/src/commands/install.ts", from: '"../../hooks/', to: '"../hooks/' },
  {
    file: "apps/cli/src/commands/doctor.ts",
    from: '"../../../../package.json"',
    to: '"../package.json"',
  },
];

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** Every file under a directory, sorted. Symlinks and anything not a regular file are refused. */
function filesIn(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Release files cannot be symlinks: ${name}`);
    if (entry.isDirectory()) files.push(...filesIn(join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported release file: ${name}`);
  }
  return files.sort();
}

function copyTree(source: string, destination: string): void {
  for (const name of filesIn(source)) {
    if (/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(name.split("/").at(-1) as string)) {
      throw new Error(`Refusing to package a local secrets file: ${name}`);
    }
    mkdirSync(dirname(join(destination, name)), { recursive: true });
    copyFileSync(join(source, name), join(destination, name));
  }
}

function fingerprint(directory: string): FileEntry[] {
  // release.json carries the id, which is derived from these files, so it is not listed.
  return filesIn(directory)
    .filter((path) => path !== "release.json")
    .map((path) => {
      const contents = readFileSync(join(directory, path));
      return { path, size: contents.length, sha256: sha256(contents) };
    });
}

function resolveTools(root: string): { vite: string; rolldown: string } {
  const fromWeb = createRequire(join(root, "apps/web/package.json"));
  const vitePackage = fromWeb.resolve("vite/package.json");
  const pkg = JSON.parse(readFileSync(vitePackage, "utf8")) as { bin: { vite: string } };
  // vite ships rolldown; resolve it from vite's own location so no new dependency is needed.
  return {
    vite: resolve(dirname(vitePackage), pkg.bin.vite),
    rolldown: createRequire(vitePackage).resolve("rolldown"),
  };
}

function buildWeb(root: string, vite: string, outDir: string): void {
  const env = { ...process.env };
  // Test hooks must never reach a shipped client.
  delete env.VITE_TV_TEST_HOOKS;
  execFileSync(process.execPath, [vite, "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: join(root, "apps/web"),
    env,
    stdio: "pipe",
  });
}

interface RolldownApi {
  rolldown(options: unknown): Promise<{ write(options: unknown): Promise<unknown> }>;
}

async function bundleCli(root: string, rolldownPath: string, file: string): Promise<void> {
  const { rolldown } = (await import(pathToFileURL(rolldownPath).href)) as RolldownApi;
  const applied = new Set<string>();
  const rewrite = {
    name: "taskville-package-paths",
    transform(code: string, id: string) {
      const rule = PATH_REWRITES.find((r) => id.split("\\").join("/").endsWith(`/${r.file}`));
      if (rule === undefined || !code.includes(rule.from)) return null;
      applied.add(rule.file);
      return { code: code.replaceAll(rule.from, rule.to), map: null };
    },
  };
  const entry = join(root, "apps/cli/src/main.ts");
  const bundle = await rolldown({
    input: entry,
    platform: "node",
    external: [/^node:/],
    plugins: [rewrite],
    logLevel: "warn",
  });
  await bundle.write({ file, format: "esm", sourcemap: false });
  for (const rule of PATH_REWRITES) {
    if (!applied.has(rule.file))
      throw new Error(`Package path rewrite did not match: ${rule.file}`);
  }
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("#!")) {
    const shebang = (readFileSync(entry, "utf8").split("\n")[0] as string).trim();
    writeFileSync(file, `${shebang}\n${text}`);
  }
}

function tarHeader(name: string, size: number, mode: number): Buffer {
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = name.slice(0, Math.max(cut, 0));
    base = name.slice(cut + 1);
    if (cut === -1 || Buffer.byteLength(base) > 100) {
      throw new Error(`Path too long to pack: ${name}`);
    }
  }
  const header = Buffer.alloc(512);
  const put = (value: string, at: number, length: number) => header.write(value, at, length);
  const octal = (value: number, length: number) =>
    `${value.toString(8).padStart(length - 1, "0")}\0`;
  put(base, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(TAR_MTIME, 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

/** A gzipped ustar archive of `<directory>` under `package/`, deterministic for the same content. */
function pack(directory: string): Buffer {
  const parts: Buffer[] = [];
  for (const path of filesIn(directory)) {
    const file = join(directory, path);
    const contents = readFileSync(file);
    const mode = statSync(file).mode & 0o111 ? 0o755 : 0o644;
    parts.push(tarHeader(`package/${path}`, contents.length, mode), contents);
    parts.push(Buffer.alloc((512 - (contents.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export async function buildRelease(options: BuildOptions): Promise<Release> {
  const { root, outDir, allowDirty = false, environment = "production" } = options;
  const commit = git(root, "rev-parse", "HEAD");
  if (!allowDirty && git(root, "status", "--porcelain") !== "") {
    throw new Error("The working tree is dirty (uncommitted changes); commit or stash them first.");
  }
  const cli = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")) as {
    version: string;
  };
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    engines?: Record<string, string>;
  };
  const version = cli.version;
  const tools = resolveTools(root);

  const work = mkdtempSync(join(tmpdir(), "tv-release-"));
  try {
    const stage = join(work, "package");
    mkdirSync(stage);

    if (options.webDir !== undefined) {
      copyTree(resolve(options.webDir), join(stage, "web"));
    } else {
      const built = join(work, "web");
      buildWeb(root, tools.vite, built);
      copyTree(built, join(stage, "web"));
    }
    if (!existsSync(join(stage, "web", "index.html"))) {
      throw new Error("The web client has no index.html.");
    }

    const bin = join(stage, "bin", "taskville.js");
    mkdirSync(dirname(bin));
    await bundleCli(root, tools.rolldown, bin);
    chmodSync(bin, 0o755);

    const hooks = join(root, "apps/cli/hooks");
    for (const name of filesIn(hooks)) {
      mkdirSync(join(stage, "hooks"), { recursive: true });
      copyFileSync(join(hooks, name), join(stage, "hooks", name));
      chmodSync(
        join(stage, "hooks", name),
        statSync(join(hooks, name)).mode & 0o111 ? 0o755 : 0o644,
      );
    }

    writeFileSync(
      join(stage, "package.json"),
      json({
        name: "taskville",
        version,
        description: "Taskville: a local-first view of your coding agents.",
        type: "module",
        bin: { taskville: "bin/taskville.js" },
        ...(rootPackage.engines === undefined ? {} : { engines: rootPackage.engines }),
      }),
    );

    const files = fingerprint(stage);
    const digest = sha256(JSON.stringify({ format: 1, version, environment, files }));
    const id = digest.slice(0, 16);
    const releaseJson = json({ id, version, commit, environment });
    writeFileSync(join(stage, "release.json"), releaseJson);

    const tarball = pack(stage);
    const manifest = {
      format: 1,
      id,
      digest,
      version,
      commit,
      environment,
      files,
      tarball: { sha256: sha256(tarball) },
    };

    const directory = join(resolve(outDir), id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `taskville-${version}.tgz`), tarball);
    writeFileSync(join(directory, "release.json"), releaseJson);
    writeFileSync(join(directory, "manifest.json"), json(manifest));
    return { id, version, directory };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
