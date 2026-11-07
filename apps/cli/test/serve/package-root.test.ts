import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RELEASE_DIR } from "../../src/commands/serve.ts";
import { PACKAGE_ROOT } from "../../src/package-root.ts";

// M7.26 review (#423, high): `new URL("../../", import.meta.url)` in serve.ts escapes the package
// once rolldown flattens everything into package/bin/taskville.js, so a release silently reported
// dev. The package root comes from one module directly under apps/cli/src: one level above its own
// directory, which is apps/cli in a checkout and package/ in the flat bundle.

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("package root", () => {
  it("lives in a module directly under apps/cli/src", () => {
    expect(existsSync(join(CLI_DIR, "src", "package-root.ts"))).toBe(true);
  });

  it("resolves to apps/cli in a checkout", () => {
    expect(resolve(PACKAGE_ROOT)).toBe(CLI_DIR);
  });

  it("is what serve uses as its release directory", () => {
    expect(RELEASE_DIR).toBe(PACKAGE_ROOT);
  });

  it("keeps serve.ts free of its own import.meta.url", () => {
    const source = readFileSync(join(CLI_DIR, "src", "commands", "serve.ts"), "utf8");
    expect(source).not.toContain("import.meta.url");
  });
});
