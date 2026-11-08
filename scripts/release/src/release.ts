// Release packaging (M7.02, #83): one installable tarball with a release identity and a manifest.
// Shape follows docs/spikes/S-3-staging.md option C and jaqstudios/scripts/release.mjs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

const ENVIRONMENTS = ["development", "staging", "production"];

/** Modules in the bundle that may read `import.meta.url`; any other workspace module is refused. */
const URL_ALLOWLIST = ["apps/cli/src/main.ts", "apps/cli/src/package-root.ts"];

/** Names that look like credentials; none may be in the staged package. */
const SECRET_NAMES = [
  /^\.env(\..*)?$/,
  /^\.dev\.vars(\..*)?$/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /\.(pem|key|p12|pfx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^credentials\.json$/,
];

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
    mkdirSync(dirname(join(destination, name)), { recursive: true });
    copyFileSync(join(source, name), join(destination, name));
  }
}

/** Refuses a credentials-looking file anywhere in the tree. */
function refuseSecrets(directory: string): void {
  for (const name of filesIn(directory)) {
    const base = name.split("/").at(-1) as string;
    if (SECRET_NAMES.some((pattern) => pattern.test(base))) {
      throw new Error(`Refusing to package a local secrets file: ${name}`);
    }
  }
}

interface LockFacts {
  /** `packages:<key>` and `snapshots:<key>` for every package entry. */
  keys: Set<string>;
  /** Package key to its resolution integrity, where it has one. */
  integrity: Map<string, string>;
  /** `<importer> <dependency>` to its `specifier -> version` resolution. */
  importers: Map<string, string>;
  /** Importer dependency ids listed under `optionalDependencies`. */
  optional: Set<string>;
  /** Package key to its os/cpu/libc restrictions (pnpm skips these on other platforms). */
  restricted: Map<string, Restriction>;
}

/** The os, cpu and libc lists of a package; pnpm lists may hold negations such as `!win32`. */
type Restriction = Partial<Record<"os" | "cpu" | "libc", string[]>>;

/** The machine an install runs on. libc is only known on linux. */
export interface Platform {
  os: string;
  cpu: string;
  libc?: string;
}

function currentPlatform(): Platform {
  const platform: Platform = { os: process.platform, cpu: process.arch };
  if (process.platform === "linux") {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    platform.libc = report?.header?.glibcVersionRuntime ? "glibc" : "musl";
  }
  return platform;
}

/** A field matches when the value is listed or, for negation-only lists, not negated. */
function listMatches(list: string[], value: string): boolean {
  if (list.includes(`!${value}`)) return false;
  const listed = list.filter((item) => !item.startsWith("!"));
  return listed.length === 0 || listed.includes(value);
}

/** True when any restricted field rules this platform out, so pnpm does not install the package. */
function excludes(restriction: Restriction | undefined, platform: Platform): boolean {
  if (restriction === undefined) return false;
  return (["os", "cpu", "libc"] as const).some((field) => {
    const list = restriction[field];
    const value = platform[field];
    return list !== undefined && value !== undefined && !listMatches(list, value);
  });
}

/** Importer groups pnpm installs; the others (config, package manager) are not in node_modules. */
const DEPENDENCY_GROUPS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

const unquote = (text: string): string => text.trim().replace(/^'(.*)'$/, "$1");

/** Reads the parts of a pnpm lockfile the release guard compares (pnpm writes a regular layout). */
function lockFacts(text: string): LockFacts {
  const facts: LockFacts = {
    keys: new Set(),
    integrity: new Map(),
    importers: new Map(),
    optional: new Set(),
    restricted: new Map(),
  };
  let section = "";
  let importer = "";
  let group = "";
  let dependency = "";
  let key = "";
  // pnpm writes the package manager's own lock as a leading document; node_modules has only the last.
  for (const line of (text.split(/^---\s*$/m).at(-1) as string).split("\n")) {
    if (/^[a-z]\w*:/.test(line)) {
      section = line.slice(0, line.indexOf(":"));
      continue;
    }
    if (section === "importers") {
      const entry = /^ {2}(?! )(.+?):\s*$/.exec(line);
      const kind = /^ {4}(?! )(\w+):\s*$/.exec(line);
      const name = /^ {6}(?! )(.+?):\s*$/.exec(line);
      const field = /^ {8}(specifier|version):\s*(.+?)\s*$/.exec(line);
      if (entry !== null) importer = unquote(entry[1] as string);
      else if (kind !== null) group = kind[1] as string;
      else if (name !== null) {
        dependency = unquote(name[1] as string);
        if (group === "optionalDependencies") facts.optional.add(`${importer} ${dependency}`);
      } else if (field !== null && DEPENDENCY_GROUPS.has(group)) {
        const id = `${importer} ${dependency}`;
        const [specifier = "", version = ""] = (facts.importers.get(id) ?? "").split(" -> ");
        const value = unquote(field[2] as string);
        facts.importers.set(
          id,
          field[1] === "specifier" ? `${value} -> ${version}` : `${specifier} -> ${value}`,
        );
      }
    } else if (section === "packages" || section === "snapshots") {
      const entry = /^ {2}(?! )(.+?):(?:\s*\{\})?\s*$/.exec(line);
      const restriction = /^ {4}(os|cpu|libc):\s*\[(.*)\]\s*$/.exec(line);
      const integrity = /^ {4}resolution:.*integrity:\s*([^,}\s]+)/.exec(line);
      if (entry !== null) {
        key = `${section}:${unquote(entry[1] as string)}`;
        facts.keys.add(key);
      } else if (integrity !== null) facts.integrity.set(key, integrity[1] as string);
      else if (restriction !== null) {
        const list = (restriction[2] as string).split(",").map(unquote).filter(Boolean);
        facts.restricted.set(key, {
          ...facts.restricted.get(key),
          [restriction[1] as string]: list,
        });
      }
    }
  }
  return facts;
}

/**
 * The installed lockfile must agree with the committed one. It is a subset (pnpm leaves out
 * packages for other platforms), so a byte compare would refuse healthy installs: every installed
 * package key, package integrity and importer resolution must instead match the committed
 * lockfile, and every committed package key, snapshot key and importer resolution must be present.
 * The only omission allowed is a platform skip: a package (or an optional dependency on one) whose
 * committed os/cpu/libc restriction excludes the given platform.
 */
export function checkInstalledLock(
  committedYaml: string,
  installedYaml: string,
  platform: Platform = currentPlatform(),
): void {
  const pinned = lockFacts(committedYaml);
  const installed = lockFacts(installedYaml);
  const differs = "node_modules/.pnpm/lock.yaml differs from pnpm-lock.yaml";
  const stray = [...installed.keys].filter((k) => !pinned.keys.has(k));
  if (stray.length > 0) {
    throw new Error(`${differs} (${stray.slice(0, 3).join(", ")}); run pnpm install.`);
  }
  const unplatformed = (k: string): boolean => {
    // Snapshot keys carry peer suffixes; the restriction lives on the package entry.
    const base = `packages:${k.slice(k.indexOf(":") + 1).replace(/\(.*$/, "")}`;
    return excludes(pinned.restricted.get(base), platform);
  };
  const missing = [...pinned.keys].filter((k) => !installed.keys.has(k) && !unplatformed(k));
  if (missing.length > 0) {
    throw new Error(`${differs} (missing ${missing.slice(0, 3).join(", ")}); run pnpm install.`);
  }
  const integrity = [...installed.keys].filter(
    (k) => pinned.integrity.get(k) !== installed.integrity.get(k),
  );
  if (integrity.length > 0) {
    const names = integrity.slice(0, 3);
    throw new Error(`${differs}: integrity changed (${names.join(", ")}); run pnpm install.`);
  }
  const skipped = (id: string, resolution: string): boolean => {
    // A platform skip: an optional dependency on a package this platform is excluded from.
    const name = id.slice(id.indexOf(" ") + 1);
    const version = (resolution.split(" -> ")[1] ?? "").replace(/\(.*$/, "");
    const key = `packages:${name}@${version}`;
    return pinned.optional.has(id) && unplatformed(key) && !installed.keys.has(key);
  };
  const importers = [
    ...[...installed.importers].filter(([k, v]) => pinned.importers.get(k) !== v),
    ...[...pinned.importers].filter(([k, v]) => !installed.importers.has(k) && !skipped(k, v)),
  ];
  if (importers.length > 0) {
    const names = importers.slice(0, 3).map(([k]) => k);
    throw new Error(
      `${differs}: importer resolution changed (${names.join(", ")}); run pnpm install.`,
    );
  }
}

/** The installed packages must be the ones pnpm-lock.yaml pins. Returns its sha256. */
function checkLockfile(root: string): string {
  const committed = readFileSync(join(root, "pnpm-lock.yaml"));
  const installedPath = join(root, "node_modules/.pnpm/lock.yaml");
  if (!existsSync(installedPath)) {
    throw new Error("node_modules/.pnpm/lock.yaml is missing; run pnpm install before a release.");
  }
  checkInstalledLock(committed.toString("utf8"), readFileSync(installedPath, "utf8"));
  return sha256(committed);
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

function buildWeb(root: string, vite: string, outDir: string, work: string): void {
  // No caller VITE_* variable and no .env file may reach a shipped client, and test hooks are off.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("VITE_")) env[key] = value;
  }
  env.VITE_TV_TEST_HOOKS = "";
  // An inherited NODE_ENV=test (vitest sets it) would switch the React plugin to development JSX,
  // which embeds the absolute path of every source file in the client.
  env.NODE_ENV = "production";
  const envDir = join(work, "no-env");
  mkdirSync(envDir);
  const web = join(root, "apps/web");
  const config = join(work, "vite.release.config.mjs");
  writeFileSync(
    config,
    `import base from ${JSON.stringify(pathToFileURL(join(web, "vite.config.ts")).href)};\n` +
      `export default { ...base, root: ${JSON.stringify(web)}, envDir: ${JSON.stringify(envDir)} };\n`,
  );
  execFileSync(
    process.execPath,
    [
      vite,
      "build",
      "--mode",
      "production",
      "--config",
      config,
      "--outDir",
      outDir,
      "--emptyOutDir",
    ],
    { cwd: web, env, stdio: "pipe" },
  );
}

interface RolldownApi {
  rolldown(options: unknown): Promise<{ write(options: unknown): Promise<unknown> }>;
}

async function bundleCli(root: string, rolldownPath: string, file: string): Promise<void> {
  const { rolldown } = (await import(pathToFileURL(rolldownPath).href)) as RolldownApi;
  const realRoot = realpathSync(root);
  const applied = new Set<string>();
  const allowed = new Set([...URL_ALLOWLIST, ...PATH_REWRITES.map((r) => r.file)]);
  const rewrite = {
    name: "taskville-package-paths",
    transform(code: string, id: string) {
      const path = id.split("\\").join("/");
      // Fails closed: a module that locates itself by import.meta.url would resolve against the
      // flat bundle, not its source folder, so it must be reviewed and allowlisted first.
      if (
        !path.includes("/node_modules/") &&
        !path.startsWith("\0") &&
        code.includes("import.meta.url")
      ) {
        const file = relative(realRoot, realpathSync(id)).split("\\").join("/");
        if (!allowed.has(file)) {
          throw new Error(`${file} uses import.meta.url, which the release bundle cannot honour.`);
        }
      }
      const rule = PATH_REWRITES.find((r) => path.endsWith(`/${r.file}`));
      if (rule === undefined || !code.includes(rule.from)) return null;
      applied.add(rule.file);
      return { code: code.replaceAll(rule.from, rule.to), map: null };
    },
  };
  const entry = join(root, "apps/cli/src/main.ts");
  const bundle = await rolldown({
    input: entry,
    cwd: root,
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
  // Only plain ASCII is packed, so a character is a byte and the 100/155 field limits are exact.
  if (!/^[\x20-\x7e]+$/.test(name))
    throw new Error(
      `Path is not plain ASCII, so it is refused (a ustar header cannot hold it safely; too long if multi-byte): ${name}`,
    );
  let prefix = "";
  let base = name;
  if (name.length > 100) {
    let cut = name.lastIndexOf("/", 155);
    while (cut !== -1 && name.length - cut - 1 > 100) cut = name.lastIndexOf("/", cut - 1);
    if (cut <= 0) throw new Error(`Path too long to pack: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
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
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(`Unknown environment "${environment}"; use ${ENVIRONMENTS.join(", ")}.`);
  }
  const commit = git(root, "rev-parse", "HEAD");
  const status = git(root, "status", "--porcelain");
  const dirty = status !== "";
  if (dirty && environment === "production") {
    throw new Error(
      "Refusing to build a production release from a dirty working tree (uncommitted changes); commit or stash them. --allow-dirty does not apply to production.",
    );
  }
  if (dirty && !allowDirty) {
    throw new Error("The working tree is dirty (uncommitted changes); commit or stash them first.");
  }
  const cli = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")) as {
    version: string;
  };
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    engines?: Record<string, string>;
  };
  const version = cli.version;
  const lockfile = checkLockfile(root);
  const tools = resolveTools(root);

  const work = mkdtempSync(join(tmpdir(), "tv-release-"));
  try {
    const stage = join(work, "package");
    mkdirSync(stage);

    if (options.webDir !== undefined) {
      copyTree(resolve(options.webDir), join(stage, "web"));
    } else {
      const built = join(work, "web");
      buildWeb(root, tools.vite, built, work);
      copyTree(built, join(stage, "web"));
    }
    if (!existsSync(join(stage, "web", "index.html"))) {
      throw new Error("The web client has no index.html.");
    }
    refuseSecrets(join(stage, "web"));

    const bin = join(stage, "bin", "taskville.js");
    mkdirSync(dirname(bin));
    await bundleCli(root, tools.rolldown, bin);
    chmodSync(bin, 0o755);

    // Only tracked scripts are shipped, never whatever else sits in the folder.
    const tracked = git(root, "ls-files", "--", "apps/cli/hooks").split("\n").filter(Boolean);
    for (const path of tracked) {
      const name = path.slice("apps/cli/hooks/".length);
      const source = join(root, path);
      const info = lstatSync(source);
      if (!info.isFile()) throw new Error(`Release files cannot be symlinks: ${path}`);
      mkdirSync(dirname(join(stage, "hooks", name)), { recursive: true });
      copyFileSync(source, join(stage, "hooks", name));
      chmodSync(join(stage, "hooks", name), info.mode & 0o111 ? 0o755 : 0o644);
    }
    if (tracked.length === 0) throw new Error("apps/cli/hooks has no tracked scripts.");

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
    refuseSecrets(stage);

    const files = fingerprint(stage);
    const digest = sha256(
      JSON.stringify({ format: 1, version, environment, commit, dirty, lockfile, files }),
    );
    const id = digest.slice(0, 16);
    const releaseJson = json({ id, version, commit, environment, ...(dirty ? { dirty } : {}) });
    writeFileSync(join(stage, "release.json"), releaseJson);

    const tarball = pack(stage);
    const manifestText = json({
      format: 1,
      id,
      digest,
      version,
      commit,
      ...(dirty ? { dirty } : {}),
      environment,
      lockfile: { sha256: lockfile },
      release: { sha256: sha256(releaseJson) },
      files,
      tarball: { sha256: sha256(tarball) },
    });

    // The tree must still be what was packaged before anything is written.
    if (
      git(root, "rev-parse", "HEAD") !== commit ||
      git(root, "status", "--porcelain") !== status
    ) {
      throw new Error("The repository changed during the build; run it again.");
    }
    const directory = join(resolve(outDir), id);
    const outputs: [string, Buffer | string][] = [
      [`taskville-${version}.tgz`, tarball],
      ["release.json", releaseJson],
      ["manifest.json", manifestText],
    ];
    for (const [name, data] of outputs) {
      const path = join(directory, name);
      if (existsSync(path) && !readFileSync(path).equals(Buffer.from(data))) {
        throw new Error(`${path} already exists and differs from this build; not overwriting.`);
      }
    }
    mkdirSync(directory, { recursive: true });
    for (const [name, data] of outputs) writeFileSync(join(directory, name), data);
    return { id, version, directory };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
