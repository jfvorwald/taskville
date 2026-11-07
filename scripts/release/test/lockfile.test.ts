import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkInstalledLock } from "../src/release.ts";

// M7.27 (#425): the release lockfile guard compares package integrity and importer resolutions,
// not only package keys. Red-phase tests.
//
// Contract under test: scripts/release/src/release.ts exports
//   checkInstalledLock(committedYaml: string, installedYaml: string): void
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

describe("checkInstalledLock", () => {
  it("accepts an identical lockfile", () => {
    expect(() => checkInstalledLock(committed, committed)).not.toThrow();
  });

  it("accepts an install that omits other platforms' optional packages", () => {
    expect(healthy).not.toContain("exe.linux-x64");
    expect(() => checkInstalledLock(committed, healthy)).not.toThrow();
  });

  it("accepts a committed lockfile that only gained a comment", () => {
    expect(() => checkInstalledLock(`# touched\n${committed}\n# end\n`, healthy)).not.toThrow();
  });

  it("refuses a changed package integrity value", () => {
    const tampered = healthy.replace("sha512-AAAA", "sha512-ZZZZ");
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered)).toThrow(/integrity/i);
  });

  it("refuses a changed importer version", () => {
    const tampered = healthy.replace("version: 3.0.1\n", "version: 3.0.0\n");
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered)).toThrow(/importer/i);
  });

  it("refuses a changed importer specifier", () => {
    const tampered = healthy.replace("specifier: ^3.0.1", "specifier: ^3.0.0");
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered)).toThrow(/importer/i);
  });

  it("refuses an importer dependency the committed lockfile does not have", () => {
    const tampered = healthy.replace(
      "      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n",
      "      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n      is-even:\n        specifier: 1.0.0\n        version: 1.0.0\n",
    );
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered)).toThrow(/importer/i);
  });

  it("still refuses a package key the committed lockfile does not pin", () => {
    const tampered = healthy.replace("left-pad@1.3.0:", "left-pad@1.3.1:");
    expect(() => checkInstalledLock(committed, tampered)).toThrow(/lock\.yaml|pnpm-lock/i);
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
    expect(() => checkInstalledLock(committed, tampered)).toThrow(/integrity/i);
  });

  it("refuses a package entry whose resolution line is gone entirely", () => {
    const tampered = healthy.replace("    resolution: {integrity: sha512-BBBB}\n", "");
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered)).toThrow(/integrity/i);
  });

  it("refuses a dependency the installed importer omits", () => {
    const tampered = healthy.replace(
      "      is-odd:\n        specifier: ^3.0.1\n        version: 3.0.1\n",
      "",
    );
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered)).toThrow(/importer/i);
  });

  it("refuses a whole importer the installed lockfile omits", () => {
    const at = healthy.indexOf("  apps/cli:");
    const end = healthy.indexOf("\npackages:");
    const tampered = healthy.slice(0, at) + healthy.slice(end);
    expect(tampered).not.toBe(healthy);
    expect(() => checkInstalledLock(committed, tampered)).toThrow(/importer/i);
  });

  it("accepts an optional dependency pnpm skipped for this platform", () => {
    expect(importerWithOptional).not.toBe(committed);
    expect(() => checkInstalledLock(importerWithOptional, healthy)).not.toThrow();
  });

  it("refuses an omitted optional dependency whose package is still installed", () => {
    // Listed under optionalDependencies and not restricted: skipping it is not a platform skip.
    const unrestricted = importerWithOptional
      .replace("    os: [linux]\n", "")
      .replace("    cpu: [x64]\n", "");
    expect(() => checkInstalledLock(unrestricted, committed)).toThrow(/importer/i);
  });
});
