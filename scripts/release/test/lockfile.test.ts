import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkInstalledLock } from "../src/release.ts";

// M7.27 (#425): the release lockfile guard compares package integrity and importer resolutions,
// not only package keys. Red-phase tests.
//
// Contract under test: scripts/release/src/release.ts exports
//   checkInstalledLock(committedYaml: string, installedYaml: string,
//     platform?: { os: string; cpu: string; libc?: string }): void
// which throws an Error (message names "integrity", "importer", or lock.yaml for the matching
// kind of disagreement) when the installed lockfile (node_modules/.pnpm/
// lock.yaml) disagrees with the committed one on a package key, a package integrity value, or an
// importer's specifier/version for a dependency. The installed lockfile may omit packages (pnpm
// skips other platforms' optional binaries); omissions are allowed. buildRelease must call it.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const HEADER = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
`;

const IMPORTERS = `
importers:

  .:
    devDependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

  apps/cli:
    dependencies:
      '@taskville/engine':
        specifier: workspace:*
        version: link:../engine
      is-odd:
        specifier: ^3.0.1
        version: 3.0.1
`;

const PACKAGES = `
packages:

  is-odd@3.0.1:
    resolution: {integrity: sha512-AAAA}

  left-pad@1.3.0:
    resolution: {integrity: sha512-BBBB}

  '@pnpm/exe.linux-x64@12.4.2':
    resolution: {integrity: sha512-CCCC}
    cpu: [x64]
    os: [linux]

snapshots:

  is-odd@3.0.1: {}

  left-pad@1.3.0: {}

  '@pnpm/exe.linux-x64@12.4.2':
    optional: true
`;

const committed = `${HEADER}${IMPORTERS}${PACKAGES}`;

/** The same lockfile as pnpm writes it on a platform that skips the linux binary. */
const healthy = committed
  .replace(
    /\n {2}'@pnpm\/exe\.linux-x64@12\.4\.2':\n {4}resolution:.*\n {4}cpu:.*\n {4}os:.*\n/,
    "\n",
  )
  .replace(/\n {2}'@pnpm\/exe\.linux-x64@12\.4\.2':\n {4}optional: true\n/, "\n");

type Platform = { os: string; cpu: string; libc?: string };
// Pinned so outcomes do not depend on the host: `healthy` omits the linux-x64 binary, which a
// linux x64 host (CI) must install.
const MAC: Platform = { os: "darwin", cpu: "arm64" };

describe("checkInstalledLock", () => {
  it("accepts an identical lockfile", () => {
    expect(() => checkInstalledLock(committed, committed)).not.toThrow();
  });

  it("accepts an install that omits other platforms' optional packages", () => {
    expect(healthy).not.toContain("exe.linux-x64");
    expect(() => checkInstalledLock(committed, healthy, MAC)).not.toThrow();
  });

  it("accepts a committed lockfile that only gained a comment", () => {
    expect(() =>
      checkInstalledLock(`# touched\n${committed}\n# end\n`, healthy, MAC),
    ).not.toThrow();
  });

  it("refuses a changed package integrity value", () => {
    const tampered = healthy.replace("sha512-AAAA", "sha512-ZZZZ");
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered, MAC)).toThrow(/integrity/i);
  });

  it("refuses a changed importer version", () => {
    const tampered = healthy.replace("version: 3.0.1\n", "version: 3.0.0\n");
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered, MAC)).toThrow(/importer/i);
  });

  it("refuses a changed importer specifier", () => {
    const tampered = healthy.replace("specifier: ^3.0.1", "specifier: ^3.0.0");
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered, MAC)).toThrow(/importer/i);
  });

  it("refuses an importer dependency the committed lockfile does not have", () => {
    const tampered = healthy.replace(
      "      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n",
      "      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n      is-even:\n        specifier: 1.0.0\n        version: 1.0.0\n",
    );
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered, MAC)).toThrow(/importer/i);
  });

  it("still refuses a package key the committed lockfile does not pin", () => {
    const tampered = healthy.replace("left-pad@1.3.0:", "left-pad@1.3.1:");
    expect(() => checkInstalledLock(committed, tampered, MAC)).toThrow(/lock\.yaml|pnpm-lock/i);
  });

  it("accepts this repository's real installed lockfile", () => {
    const real = readFileSync(`${ROOT}node_modules/.pnpm/lock.yaml`, "utf8");
    expect(() =>
      checkInstalledLock(readFileSync(`${ROOT}pnpm-lock.yaml`, "utf8"), real),
    ).not.toThrow();
  });
});

describe("checkInstalledLock omissions (roborev 7219)", () => {
  const optionalBlock =
    "      '@pnpm/exe.linux-x64':\n        specifier: 12.4.2\n        version: 12.4.2\n";
  const importerWithOptional = committed.replace(
    "      is-odd:\n        specifier: ^3.0.1\n        version: 3.0.1\n",
    `      is-odd:\n        specifier: ^3.0.1\n        version: 3.0.1\n    optionalDependencies:\n${optionalBlock}`,
  );

  it("refuses a package entry that keeps its key but loses its integrity", () => {
    const tampered = healthy.replace(
      "    resolution: {integrity: sha512-AAAA}\n",
      "    resolution: {}\n",
    );
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered, MAC)).toThrow(/integrity/i);
  });

  it("refuses a package entry whose resolution line is gone entirely", () => {
    const tampered = healthy.replace("    resolution: {integrity: sha512-BBBB}\n", "");
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered, MAC)).toThrow(/integrity/i);
  });

  it("refuses a dependency the installed importer omits", () => {
    const tampered = healthy.replace(
      "      is-odd:\n        specifier: ^3.0.1\n        version: 3.0.1\n",
      "",
    );
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered, MAC)).toThrow(/importer/i);
  });

  it("refuses a whole importer the installed lockfile omits", () => {
    const at = healthy.indexOf("  apps/cli:");
    const end = healthy.indexOf("\npackages:");
    const tampered = healthy.slice(0, at) + healthy.slice(end);
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered, MAC)).toThrow(/importer/i);
  });

  it("accepts an optional dependency pnpm skipped for this platform", () => {
    expect(importerWithOptional).not.toBe(committed);
    // Pinned: the linux-x64 binary is legitimately absent on macOS arm64 (M7.29).
    expect(() =>
      checkInstalledLock(importerWithOptional, healthy, { os: "darwin", cpu: "arm64" }),
    ).not.toThrow();
  });

  it("refuses an omitted optional dependency whose package is still installed", () => {
    // Listed under optionalDependencies and not restricted: skipping it is not a platform skip.
    const unrestricted = importerWithOptional
      .replace("    os: [linux]\n", "")
      .replace("    cpu: [x64]\n", "");
    expect(() =>
      checkInstalledLock(unrestricted, committed, { os: "darwin", cpu: "arm64" }),
    ).toThrow(/importer/i);
  });
});

// M7.29 (#428): the guard takes an optional third argument pinning the platform so tests do not
// depend on the host. Assumed signature:
//   checkInstalledLock(committedYaml: string, installedYaml: string,
//     platform?: { os: string; cpu: string; libc?: string }): void
// defaulting to the real platform (process.platform, process.arch, detected libc).
const LINUX: Platform = { os: "linux", cpu: "x64", libc: "glibc" };

interface Binary {
  name: string;
  version: string;
  restrictions: string[];
}

const BINARIES: Binary[] = [
  { name: "bin-darwin-arm64", version: "1.0.0", restrictions: ["cpu: [arm64]", "os: [darwin]"] },
  {
    name: "bin-linux-x64-gnu",
    version: "1.0.0",
    restrictions: ["cpu: [x64]", "os: [linux]", "libc: [glibc]"],
  },
  {
    name: "bin-linux-x64-musl",
    version: "1.0.0",
    restrictions: ["cpu: [x64]", "os: [linux]", "libc: [musl]"],
  },
  { name: "bin-not-windows", version: "1.0.0", restrictions: ["os: ['!win32']"] },
];

function lock(options: {
  binaries: Binary[];
  extraPackage?: boolean;
  extraSnapshot?: boolean;
}): string {
  const optional = options.binaries
    .map(
      (b) => `      ${b.name}:\n        specifier: ${b.version}\n        version: ${b.version}\n`,
    )
    .join("");
  const packages = options.binaries
    .map(
      (b) =>
        `  ${b.name}@${b.version}:\n    resolution: {integrity: sha512-${b.name}}\n${b.restrictions.map((r) => `    ${r}\n`).join("")}\n`,
    )
    .join("");
  const snapshots = options.binaries
    .map((b) => `  ${b.name}@${b.version}:\n    optional: true\n\n`)
    .join("");
  const transitivePackage =
    options.extraPackage === false
      ? ""
      : "  shared-dep@2.0.0:\n    resolution: {integrity: sha512-SHARED}\n\n";
  const transitiveSnapshot = options.extraSnapshot === false ? "" : "  shared-dep@2.0.0: {}\n\n";
  return `${HEADER}
importers:

  .:
    dependencies:
      is-odd:
        specifier: ^3.0.1
        version: 3.0.1
    optionalDependencies:
${optional}
packages:

  is-odd@3.0.1:
    resolution: {integrity: sha512-AAAA}

${transitivePackage}${packages}snapshots:

  is-odd@3.0.1: {}

${transitiveSnapshot}${snapshots}`;
}

const names = (...n: string[]) => BINARIES.filter((b) => n.includes(b.name));

describe("checkInstalledLock platform omissions (M7.29)", () => {
  const all = lock({ binaries: BINARIES });

  it("refuses an omitted optional dependency whose restriction includes this platform", () => {
    // darwin/arm64 must install bin-darwin-arm64; omitting it is a stale install.
    const installed = lock({
      binaries: names("bin-linux-x64-gnu", "bin-linux-x64-musl", "bin-not-windows"),
    });
    expect(() => checkInstalledLock(all, installed, MAC)).toThrow(/lock\.yaml|importer/i);
  });

  it("refuses an omitted optional dependency whose negated os list includes this platform", () => {
    // os: ['!win32'] applies on linux, so bin-not-windows must be installed there.
    const installed = lock({ binaries: names("bin-linux-x64-gnu") });
    expect(() => checkInstalledLock(all, installed, LINUX)).toThrow(/lock\.yaml|importer/i);
  });

  it("refuses an omitted optional dependency when only libc matches this platform", () => {
    // Same os and cpu on linux/x64; the glibc variant must be there, only the musl one may be absent.
    const installed = lock({ binaries: names("bin-not-windows", "bin-linux-x64-musl") });
    expect(() => checkInstalledLock(all, installed, LINUX)).toThrow(/lock\.yaml|importer/i);
  });

  it("accepts an omitted optional dependency whose restriction excludes this platform", () => {
    const onlyWindows = lock({ binaries: names("bin-linux-x64-gnu") });
    const committedWithWindowsOnly = lock({
      binaries: [
        ...names("bin-linux-x64-gnu"),
        { name: "bin-win32-x64", version: "1.0.0", restrictions: ["cpu: [x64]", "os: [win32]"] },
      ],
    });
    expect(() => checkInstalledLock(committedWithWindowsOnly, onlyWindows, LINUX)).not.toThrow();
  });

  it("refuses a package key the installed lockfile omits while importers are unchanged", () => {
    const installed = all.replace(
      "  shared-dep@2.0.0:\n    resolution: {integrity: sha512-SHARED}\n\n",
      "",
    );
    expect(installed).not.toBe(all);
    expect(() => checkInstalledLock(all, installed, MAC)).toThrow(/lock\.yaml|shared-dep/i);
  });

  it("refuses a snapshot key the installed lockfile omits while importers are unchanged", () => {
    const installed = all.replace("  shared-dep@2.0.0: {}\n\n", "");
    expect(installed).not.toBe(all);
    expect(() => checkInstalledLock(all, installed, MAC)).toThrow(/lock\.yaml|shared-dep/i);
  });

  it("accepts a healthy macOS arm64 install", () => {
    const installed = lock({ binaries: names("bin-darwin-arm64", "bin-not-windows") });
    expect(() => checkInstalledLock(all, installed, MAC)).not.toThrow();
  });

  it("accepts a healthy Linux x64 glibc install", () => {
    const installed = lock({ binaries: names("bin-linux-x64-gnu", "bin-not-windows") });
    expect(() => checkInstalledLock(all, installed, LINUX)).not.toThrow();
  });
});
